use std::io::{Read, Seek};

pub struct Assets {
    pub tts_pad: Vec<f32>,
    pub proj_weight: Vec<f32>,
    pub proj_bias: Vec<f32>,
    pub codec_embeddings: Vec<Vec<f32>>,
    pub text_table: Vec<f32>,
}

impl Assets {
    pub fn load(model_dir: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        // println!("[TTS] Loading assets from: {}", model_dir.display());
        let gguf_path = model_dir.join("qwen3_assets.gguf");

        if gguf_path.exists() {
            // println!("[TTS] Found GGUF assets: {}", gguf_path.display());
            return Self::load_gguf(&gguf_path);
        }

        Err("GGUF assets file not found".into())
    }

    fn load_gguf(path: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        let file = std::fs::File::open(path)?;
        let mut reader = std::io::BufReader::new(file);

        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic)?;
        if &magic != b"GGUF" {
            return Err("Not a GGUF file".into());
        }

        let mut version_bytes = [0u8; 4];
        reader.read_exact(&mut version_bytes)?;
        let version = u32::from_le_bytes(version_bytes);
        if version < 2 {
            return Err(format!("Unsupported GGUF version: {}", version).into());
        }

        let mut tensor_count_bytes = [0u8; 8];
        reader.read_exact(&mut tensor_count_bytes)?;
        let tensor_count = u64::from_le_bytes(tensor_count_bytes);

        let mut kv_count_bytes = [0u8; 8];
        reader.read_exact(&mut kv_count_bytes)?;
        let kv_count = u64::from_le_bytes(kv_count_bytes);

        let read_string = |r: &mut std::io::BufReader<std::fs::File>| -> Result<String, Box<dyn std::error::Error>> {
            let mut len_bytes = [0u8; 8];
            r.read_exact(&mut len_bytes)?;
            let len = u64::from_le_bytes(len_bytes) as usize;
            let mut bytes = vec![0u8; len];
            r.read_exact(&mut bytes)?;
            Ok(String::from_utf8(bytes)?)
        };

        for _ in 0..kv_count {
            let _key = read_string(&mut reader)?;
            let mut type_bytes = [0u8; 4];
            reader.read_exact(&mut type_bytes)?;
            let val_type = u32::from_le_bytes(type_bytes);

            match val_type {
                0..=7 => {
                    let size = match val_type {
                        0 | 1 | 7 => 1,
                        2 | 3 => 2,
                        4..=6 => 4,
                        _ => 0,
                    };
                    if size > 0 {
                        let mut b = vec![0u8; size];
                        reader.read_exact(&mut b)?;
                    }
                }
                8 => {
                    let _s = read_string(&mut reader)?;
                }
                10..=12 => {
                    let mut b = [0u8; 8];
                    reader.read_exact(&mut b)?;
                }
                9 => {
                    return Err("Array type in GGUF metadata not implemented".into());
                }
                _ => return Err(format!("Unknown GGUF value type: {}", val_type).into()),
            }
        }

        #[allow(dead_code)]
        struct TensorInfo {
            name: String,
            offset: u64,
            shape: Vec<usize>,
            _type: u32,
        }
        let mut tensors = std::collections::HashMap::new();

        for _ in 0..tensor_count {
            let name = read_string(&mut reader)?;
            let mut ndim_b = [0u8; 4];
            reader.read_exact(&mut ndim_b)?;
            let n_dims = u32::from_le_bytes(ndim_b) as usize;

            let mut shape = Vec::new();
            for _ in 0..n_dims {
                let mut dim_b = [0u8; 8];
                reader.read_exact(&mut dim_b)?;
                shape.push(u64::from_le_bytes(dim_b) as usize);
            }

            let mut type_b = [0u8; 4];
            reader.read_exact(&mut type_b)?;
            let type_id = u32::from_le_bytes(type_b);

            let mut offset_b = [0u8; 8];
            reader.read_exact(&mut offset_b)?;
            let offset = u64::from_le_bytes(offset_b);

            tensors.insert(
                name.clone(),
                TensorInfo {
                    name,
                    offset,
                    shape,
                    _type: type_id,
                },
            );
        }

        let current_pos = reader.stream_position()?;
        let alignment = 32;
        let padding = (alignment - (current_pos % alignment)) % alignment;
        reader.seek(std::io::SeekFrom::Current(padding as i64))?;
        let data_start = reader.stream_position()?;

        let path_clone = path.to_path_buf();
        let read_tensor_data = |info: &TensorInfo| -> Result<Vec<f32>, Box<dyn std::error::Error>> {
            let mut f = std::fs::File::open(&path_clone)?;
            f.seek(std::io::SeekFrom::Start(data_start + info.offset))?;

            let num_elems: usize = info.shape.iter().product();

            match info._type {
                0 => {
                    let mut floats = vec![0.0f32; num_elems];
                    let byte_slice = unsafe {
                        std::slice::from_raw_parts_mut(
                            floats.as_mut_ptr() as *mut u8,
                            num_elems * 4,
                        )
                    };
                    f.read_exact(byte_slice)?;
                    Ok(floats)
                }
                8 => {
                    const QK8_0: usize = 32;
                    let num_blocks = num_elems.div_ceil(QK8_0);
                    let block_bytes = QK8_0 + 2;
                    let total_block_bytes = num_blocks * block_bytes;

                    let mut block_data = vec![0u8; total_block_bytes];
                    f.read_exact(&mut block_data)?;

                    let mut floats = vec![0.0f32; num_elems];
                    for (block_idx, block) in block_data.chunks_exact(block_bytes).enumerate() {
                        let bits = u16::from_le_bytes([block[0], block[1]]);
                        let scale = half::f16::from_bits(bits).to_f32();
                        let start = block_idx * QK8_0;
                        let end = (start + QK8_0).min(num_elems);
                        for (i, &q) in block[2..2 + (end - start)].iter().enumerate() {
                            floats[start + i] = (q as i8 as f32) * scale;
                        }
                    }
                    Ok(floats)
                }
                _ => Err(format!("Unsupported tensor type: {}", info._type).into()),
            }
        };

        let proj_weight =
            read_tensor_data(tensors.get("proj.weight").ok_or("proj.weight missing")?)?;
        let proj_bias = read_tensor_data(tensors.get("proj.bias").ok_or("proj.bias missing")?)?;

        let text_table = if let Some(info) = tensors.get("text_embd") {
            read_tensor_data(info)?
        } else {
            Vec::new()
        };

        let mut codec_embeddings = Vec::new();
        for i in 0..16 {
            let name = format!("codec_embd.{}", i);
            if let Some(info) = tensors.get(&name) {
                codec_embeddings.push(read_tensor_data(info)?);
            }
        }

        let tts_pad = if text_table.len() >= (151671 + 1) * 2048 {
            let start = 151671 * 2048;
            text_table[start..start + 2048].to_vec()
        } else {
            vec![0.0; 2048]
        };

        println!(
            "[TTS] Assets loaded: ProjW={}, TextTbl={}, Codec={}",
            proj_weight.len(),
            text_table.len(),
            codec_embeddings.len()
        );

        Ok(Self {
            tts_pad,
            proj_weight,
            proj_bias,
            codec_embeddings,
            text_table,
        })
    }

    pub fn project(&self, hidden: &[f32]) -> Vec<f32> {
        let n_out = self.proj_bias.len();
        let mut result = vec![0.0; n_out];
        self.project_into(hidden, &mut result);
        result
    }

    pub fn project_into(&self, hidden: &[f32], result: &mut [f32]) {
        let n_in = hidden.len();
        let n_out = self.proj_bias.len().min(result.len());

        let weight_view =
            ndarray::ArrayView2::from_shape((self.proj_bias.len(), n_in), &self.proj_weight)
                .unwrap();
        let bias_view = ndarray::ArrayView1::from_shape(n_out, &self.proj_bias[..n_out]).unwrap();
        let hidden_view = ndarray::ArrayView1::from_shape(n_in, hidden).unwrap();
        let mut result_view =
            ndarray::ArrayViewMut1::from_shape(n_out, &mut result[..n_out]).unwrap();

        result_view.assign(&bias_view);
        ndarray::linalg::general_mat_vec_mul(
            1.0,
            &weight_view.slice(ndarray::s![..n_out, ..]),
            &hidden_view,
            1.0,
            &mut result_view,
        );
    }

    pub fn project_embedding(&self, emb_2048: &[f32]) -> Vec<f32> {
        let n_in = 2048;
        let n_out = self.proj_bias.len();
        let mut result = vec![0.0; n_out];

        let weight_view =
            ndarray::ArrayView2::from_shape((n_out, n_in), &self.proj_weight).unwrap();
        let bias_view = ndarray::ArrayView1::from_shape(n_out, &self.proj_bias).unwrap();
        let hidden_view = ndarray::ArrayView1::from_shape(n_in, &emb_2048[..n_in]).unwrap();
        let mut result_view = ndarray::ArrayViewMut1::from_shape(n_out, &mut result).unwrap();

        result_view.assign(&bias_view);
        ndarray::linalg::general_mat_vec_mul(
            1.0,
            &weight_view,
            &hidden_view,
            1.0,
            &mut result_view,
        );

        result
    }

    pub fn get_codec_embedding(&self, q: usize, code: i32) -> Vec<f32> {
        if q < self.codec_embeddings.len() {
            let emb = &self.codec_embeddings[q];
            let code = code.max(0) as usize;
            let start = code * 2048;
            if start + 2048 <= emb.len() {
                return emb[start..start + 2048].to_vec();
            }
        }
        vec![0.0; 2048]
    }

    pub fn get_codec_embedding_ref(&self, q: usize, code: i32) -> &[f32] {
        static ZERO_EMB: &[f32] = &[0.0f32; 2048];
        if q < self.codec_embeddings.len() {
            let emb = &self.codec_embeddings[q];
            let code = code.max(0) as usize;
            let start = code * 2048;
            if start + 2048 <= emb.len() {
                return &emb[start..start + 2048];
            }
        }
        ZERO_EMB
    }

    pub fn get_codec_embedding_1024(&self, q: usize, code: i32) -> Vec<f32> {
        let emb_2048 = self.get_codec_embedding(q, code);
        self.project_embedding(&emb_2048)
    }

    pub fn get_text_embedding(&self, token_id: usize) -> Vec<f32> {
        let start = token_id * 2048;
        if start + 2048 <= self.text_table.len() {
            self.text_table[start..start + 2048].to_vec()
        } else {
            self.get_text_embedding_fallback(token_id)
        }
    }

    pub fn get_text_embedding_fallback(&self, token_id: usize) -> Vec<f32> {
        let mut result = vec![0.0; 2048];
        for i in 0..2048.min(result.len()) {
            result[i] = ((token_id * 17 + i) as f32 % 2.0) - 1.0;
        }
        result
    }
}
