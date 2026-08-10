use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// GGUF metadata value types (per GGUF spec).
#[derive(Debug, Clone)]
pub enum MetaValue {
    UInt8(u8),
    Int8(i8),
    UInt16(u16),
    Int16(i16),
    UInt32(u32),
    Int32(i32),
    UInt64(u64),
    Int64(i64),
    Float32(f32),
    Float64(f64),
    Bool(bool),
    String(String),
    Array(Vec<MetaValue>),
}

impl MetaValue {
    pub fn as_string(&self) -> Option<&str> {
        match self {
            MetaValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_u32(&self) -> Option<u32> {
        match self {
            MetaValue::UInt32(v) => Some(*v),
            MetaValue::Int32(v) => Some(*v as u32),
            MetaValue::UInt64(v) => Some(*v as u32),
            MetaValue::Int64(v) => Some(*v as u32),
            _ => None,
        }
    }

    pub fn as_f32(&self) -> Option<f32> {
        match self {
            MetaValue::Float32(v) => Some(*v),
            MetaValue::Float64(v) => Some(*v as f32),
            MetaValue::Int32(v) => Some(*v as f32),
            MetaValue::UInt32(v) => Some(*v as f32),
            _ => None,
        }
    }

    pub fn as_array_of_strings(&self) -> Option<Vec<&str>> {
        match self {
            MetaValue::Array(arr) => {
                let out: Vec<&str> = arr.iter().filter_map(|v| v.as_string()).collect();
                if out.len() == arr.len() {
                    Some(out)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub fn as_array_of_f32(&self) -> Option<Vec<f32>> {
        match self {
            MetaValue::Array(arr) => {
                let out: Vec<f32> = arr.iter().filter_map(|v| v.as_f32()).collect();
                if out.len() == arr.len() {
                    Some(out)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

/// Tensor metadata (name, shape, quant type, file offset).
#[derive(Debug, Clone)]
pub struct TensorMeta {
    pub name: String,
    pub shape: Vec<usize>,
    pub type_id: u32,
    pub offset: u64,
}

impl TensorMeta {
    /// Total number of elements (product of shape).
    pub fn num_elems(&self) -> usize {
        self.shape.iter().product()
    }

    /// Human-readable type name.
    pub fn type_name(&self) -> &'static str {
        match self.type_id {
            0 => "F32",
            1 => "F16",
            2 => "Q4_0",
            3 => "Q4_1",
            6 => "Q5_0",
            7 => "Q5_1",
            8 => "Q8_0",
            9 => "Q8_1",
            10 => "Q2_K",
            11 => "Q3_K",
            12 => "Q4_K",
            13 => "Q5_K",
            14 => "Q6_K",
            15 => "Q8_K",
            16 => "IQ2_XXS",
            17 => "IQ2_XS",
            18 => "IQ3_XXS",
            19 => "IQ1_S",
            20 => "IQ4_NL",
            21 => "IQ3_S",
            22 => "IQ2_S",
            23 => "IQ4_XS",
            24 => "I8",
            25 => "I16",
            26 => "I32",
            27 => "I64",
            28 => "F64",
            29 => "IQ1_M",
            30 => "BF16",
            _ => "Unknown",
        }
    }
}

pub struct GgufReader {
    data_start: u64,
    tensors: HashMap<String, TensorMeta>,
    metadata: HashMap<String, MetaValue>,
    path: std::path::PathBuf,
}

impl GgufReader {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let file = std::fs::File::open(path)?;
        let mut reader = BufReader::new(file);

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

        let read_string =
            |r: &mut BufReader<std::fs::File>| -> Result<String, Box<dyn std::error::Error>> {
                let mut len_bytes = [0u8; 8];
                r.read_exact(&mut len_bytes)?;
                let len = u64::from_le_bytes(len_bytes) as usize;
                let mut bytes = vec![0u8; len];
                r.read_exact(&mut bytes)?;
                Ok(String::from_utf8(bytes)?)
            };

        let mut metadata = HashMap::new();

        for _ in 0..kv_count {
            let key = read_string(&mut reader)?;
            let val = Self::read_meta_value(&mut reader)?;
            metadata.insert(key, val);
        }

        let mut tensors = HashMap::new();

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
                TensorMeta {
                    name,
                    shape,
                    type_id,
                    offset,
                },
            );
        }

        let current_pos = reader.stream_position()?;
        let alignment = 32u64;
        let padding = (alignment - (current_pos % alignment)) % alignment;
        reader.seek(SeekFrom::Current(padding as i64))?;
        let data_start = reader.stream_position()?;

        Ok(Self {
            data_start,
            tensors,
            metadata,
            path: path.to_path_buf(),
        })
    }

    fn read_meta_value(
        r: &mut BufReader<std::fs::File>,
    ) -> Result<MetaValue, Box<dyn std::error::Error>> {
        let mut type_bytes = [0u8; 4];
        r.read_exact(&mut type_bytes)?;
        let val_type = u32::from_le_bytes(type_bytes);
        Self::read_value_by_type(r, val_type)
    }

    /// Read a metadata value when the type is already known (e.g. inside an
    /// array — the element type is declared once in the array header, so each
    /// element is stored WITHOUT its own type prefix).
    ///
    /// GGUF metadata value types per official spec (llama.cpp gguf.h):
    ///   0=UINT8 1=INT8 2=UINT16 3=INT16 4=UINT32 5=INT32
    ///   6=FLOAT32 7=BOOL 8=STRING 9=ARRAY
    ///   10=UINT64 11=INT64 12=FLOAT64
    fn read_value_by_type(
        r: &mut BufReader<std::fs::File>,
        val_type: u32,
    ) -> Result<MetaValue, Box<dyn std::error::Error>> {
        match val_type {
            0 => {
                let mut b = [0u8; 1];
                r.read_exact(&mut b)?;
                Ok(MetaValue::UInt8(b[0]))
            }
            1 => {
                let mut b = [0u8; 1];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Int8(b[0] as i8))
            }
            2 => {
                let mut b = [0u8; 2];
                r.read_exact(&mut b)?;
                Ok(MetaValue::UInt16(u16::from_le_bytes(b)))
            }
            3 => {
                let mut b = [0u8; 2];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Int16(i16::from_le_bytes(b)))
            }
            4 => {
                let mut b = [0u8; 4];
                r.read_exact(&mut b)?;
                Ok(MetaValue::UInt32(u32::from_le_bytes(b)))
            }
            5 => {
                let mut b = [0u8; 4];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Int32(i32::from_le_bytes(b)))
            }
            6 => {
                let mut b = [0u8; 4];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Float32(f32::from_le_bytes(b)))
            }
            7 => {
                let mut b = [0u8; 1];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Bool(b[0] != 0))
            }
            8 => {
                let mut len_bytes = [0u8; 8];
                r.read_exact(&mut len_bytes)?;
                let len = u64::from_le_bytes(len_bytes) as usize;
                let mut bytes = vec![0u8; len];
                r.read_exact(&mut bytes)?;
                Ok(MetaValue::String(String::from_utf8(bytes)?))
            }
            9 => {
                // Array: read element type, then count, then elements.
                // IMPORTANT: each element is stored WITHOUT its own type prefix.
                let mut elem_type_b = [0u8; 4];
                r.read_exact(&mut elem_type_b)?;
                let elem_type = u32::from_le_bytes(elem_type_b);
                let mut arr_len_b = [0u8; 8];
                r.read_exact(&mut arr_len_b)?;
                let arr_len = u64::from_le_bytes(arr_len_b) as usize;
                let mut arr = Vec::with_capacity(arr_len);
                for _ in 0..arr_len {
                    arr.push(Self::read_value_by_type(r, elem_type)?);
                }
                Ok(MetaValue::Array(arr))
            }
            10 => {
                let mut b = [0u8; 8];
                r.read_exact(&mut b)?;
                Ok(MetaValue::UInt64(u64::from_le_bytes(b)))
            }
            11 => {
                let mut b = [0u8; 8];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Int64(i64::from_le_bytes(b)))
            }
            12 => {
                let mut b = [0u8; 8];
                r.read_exact(&mut b)?;
                Ok(MetaValue::Float64(f64::from_le_bytes(b)))
            }
            _ => Err(format!("Unknown metadata value type: {}", val_type).into()),
        }
    }

    // ---- Metadata accessors ----

    pub fn metadata(&self) -> &HashMap<String, MetaValue> {
        &self.metadata
    }

    pub fn architecture(&self) -> Option<&str> {
        self.metadata
            .get("general.architecture")
            .and_then(|v| v.as_string())
    }

    pub fn meta_string(&self, key: &str) -> Option<&str> {
        self.metadata.get(key).and_then(|v| v.as_string())
    }

    pub fn meta_u32(&self, key: &str) -> Option<u32> {
        self.metadata.get(key).and_then(|v| v.as_u32())
    }

    pub fn meta_f32(&self, key: &str) -> Option<f32> {
        self.metadata.get(key).and_then(|v| v.as_f32())
    }

    // ---- Tensor listing ----

    pub fn tensors(&self) -> &HashMap<String, TensorMeta> {
        &self.tensors
    }

    pub fn list_tensors(&self) -> Vec<&TensorMeta> {
        let mut out: Vec<&TensorMeta> = self.tensors.values().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn has_tensor(&self, name: &str) -> bool {
        self.tensors.contains_key(name)
    }

    // ---- Tensor reading (dequantized to f32) ----

    /// Read and dequantize a tensor by name into a flat f32 array.
    pub fn read_tensor(&self, name: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let info = self
            .tensors
            .get(name)
            .ok_or_else(|| format!("Tensor '{}' not found in GGUF", name))?;
        self.read_tensor_internal(info)
    }

    /// Read a tensor by its metadata reference.
    pub fn read_tensor_by_meta(
        &self,
        meta: &TensorMeta,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        self.read_tensor_internal(meta)
    }

    fn read_tensor_internal(
        &self,
        meta: &TensorMeta,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let num_elems = meta.num_elems();
        let mut file = std::fs::File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_start + meta.offset))?;

        log::trace!(
            "[GGUF] Reading tensor '{}': shape={:?}, elems={}, type={}",
            meta.name,
            meta.shape,
            num_elems,
            meta.type_name()
        );

        match meta.type_id {
            0 => Self::dequant_f32(&mut file, num_elems),
            1 => Self::dequant_f16(&mut file, num_elems),
            30 => Self::dequant_bf16(&mut file, num_elems),
            8 => Self::dequant_q8_0(&mut file, num_elems),
            12 => Self::dequant_q4_k(&mut file, num_elems),
            13 => Self::dequant_q5_k(&mut file, num_elems),
            14 => Self::dequant_q6_k(&mut file, num_elems),
            _ => Err(format!(
                "Unsupported tensor type: {} ({}) for tensor '{}'",
                meta.type_id,
                meta.type_name(),
                meta.name
            )
            .into()),
        }
    }

    /// Read raw bytes of a tensor (no dequantization).
    pub fn read_tensor_raw(
        &self,
        name: &str,
    ) -> Result<(Vec<u8>, u32), Box<dyn std::error::Error>> {
        let info = self
            .tensors
            .get(name)
            .ok_or_else(|| format!("Tensor '{}' not found", name))?;
        let byte_size = Self::tensor_byte_size(info.type_id, info.num_elems());
        let mut file = std::fs::File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_start + info.offset))?;
        let mut data = vec![0u8; byte_size];
        file.read_exact(&mut data)?;
        Ok((data, info.type_id))
    }

    /// Calculate byte size of a quantized tensor given type and element count.
    pub fn tensor_byte_size(type_id: u32, num_elems: usize) -> usize {
        match type_id {
            0 => num_elems * 4,  // F32
            1 => num_elems * 2,  // F16
            30 => num_elems * 2, // BF16
            8 => {
                // Q8_0: blocks of 32, each 2+32 bytes
                let blocks = num_elems.div_ceil(32);
                blocks * (2 + 32)
            }
            12 => {
                // Q4_K: blocks of 256, each 144 bytes
                let blocks = num_elems.div_ceil(256);
                blocks * 144
            }
            13 => {
                // Q5_K: blocks of 256, each 176 bytes
                let blocks = num_elems.div_ceil(256);
                blocks * 176
            }
            14 => {
                // Q6_K: blocks of 256, each 210 bytes
                let blocks = num_elems.div_ceil(256);
                blocks * 210
            }
            _ => 0,
        }
    }

    // ---- Backward compatibility ----

    pub fn read_token_embeddings(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        self.read_tensor("token_embd.weight")
    }

    // ---- Dequantization functions (shape-agnostic, 1D block processing) ----

    fn dequant_f32(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let mut floats = vec![0.0f32; num_elems];
        let byte_slice = unsafe {
            std::slice::from_raw_parts_mut(floats.as_mut_ptr() as *mut u8, num_elems * 4)
        };
        file.read_exact(byte_slice)?;
        Ok(floats)
    }

    fn dequant_f16(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let mut half_bytes = vec![0u8; num_elems * 2];
        file.read_exact(&mut half_bytes)?;
        let floats: Vec<f32> = half_bytes
            .chunks_exact(2)
            .map(|chunk| f16_to_f32(u16::from_le_bytes([chunk[0], chunk[1]])))
            .collect();
        Ok(floats)
    }

    fn dequant_bf16(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let mut bytes = vec![0u8; num_elems * 2];
        file.read_exact(&mut bytes)?;
        let floats: Vec<f32> = bytes
            .chunks_exact(2)
            .map(|chunk| {
                let bits = u16::from_le_bytes([chunk[0], chunk[1]]) as u32;
                // BF16 → F32: pad the lower 16 bits with zeros
                f32::from_bits(bits << 16)
            })
            .collect();
        Ok(floats)
    }

    fn dequant_q8_0(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        const QK8_0: usize = 32;
        const BLOCK_BYTES: usize = 2 + QK8_0;
        let num_blocks = num_elems.div_ceil(QK8_0);
        let total_bytes = num_blocks * BLOCK_BYTES;
        let mut block_data = vec![0u8; total_bytes];
        file.read_exact(&mut block_data)?;

        let mut floats = vec![0.0f32; num_elems];
        for block_idx in 0..num_blocks {
            let start = block_idx * BLOCK_BYTES;
            let d = f16_to_f32(u16::from_le_bytes([
                block_data[start],
                block_data[start + 1],
            ]));
            let qs = &block_data[start + 2..start + BLOCK_BYTES];
            let base = block_idx * QK8_0;
            for (i, &q_byte) in qs.iter().enumerate().take(QK8_0) {
                let idx = base + i;
                if idx < num_elems {
                    floats[idx] = q_byte as i8 as f32 * d;
                }
            }
        }
        Ok(floats)
    }

    fn dequant_q4_k(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        const QK_K: usize = 256;
        const K_SCALE_SIZE: usize = 12;
        const BLOCK_BYTES: usize = 2 + 2 + K_SCALE_SIZE + QK_K / 2;
        let num_blocks = num_elems.div_ceil(QK_K);
        let total_bytes = num_blocks * BLOCK_BYTES;
        let mut block_data = vec![0u8; total_bytes];
        file.read_exact(&mut block_data)?;

        let mut floats = vec![0.0f32; num_elems];
        for block_idx in 0..num_blocks {
            let start = block_idx * BLOCK_BYTES;
            let block = &block_data[start..start + BLOCK_BYTES];
            let d = f16_to_f32(u16::from_le_bytes([block[0], block[1]]));
            let dmin = f16_to_f32(u16::from_le_bytes([block[2], block[3]]));
            let scales = &block[4..4 + K_SCALE_SIZE];
            let qs = &block[4 + K_SCALE_SIZE..];
            let (sc, m) = Self::get_scale_min_k4(scales);
            let base = block_idx * QK_K;

            for group in 0..4 {
                for shift in 0..2 {
                    let out_group = group * 2 + shift;
                    let group_start = base + out_group * 32;
                    let scale = d * (sc[out_group] as f32);
                    let min_val = dmin * (m[out_group] as f32);

                    for i in 0..32 {
                        let idx = group_start + i;
                        if idx < num_elems {
                            let q = qs[group * 32 + i];
                            let v = ((q >> (shift * 4)) & 0x0F) as f32;
                            floats[idx] = scale * v - min_val;
                        }
                    }
                }
            }
        }
        Ok(floats)
    }

    fn dequant_q5_k(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        const QK_K: usize = 256;
        const K_SCALE_SIZE: usize = 12;
        const BLOCK_BYTES: usize = 2 + 2 + K_SCALE_SIZE + QK_K / 8 + QK_K / 2;
        let num_blocks = num_elems.div_ceil(QK_K);
        let total_bytes = num_blocks * BLOCK_BYTES;
        let mut block_data = vec![0u8; total_bytes];
        file.read_exact(&mut block_data)?;

        let mut floats = vec![0.0f32; num_elems];
        for block_idx in 0..num_blocks {
            let start = block_idx * BLOCK_BYTES;
            let block = &block_data[start..start + BLOCK_BYTES];
            let d = f16_to_f32(u16::from_le_bytes([block[0], block[1]]));
            let dmin = f16_to_f32(u16::from_le_bytes([block[2], block[3]]));
            let scales = &block[4..4 + K_SCALE_SIZE];
            let qh = &block[4 + K_SCALE_SIZE..4 + K_SCALE_SIZE + QK_K / 8];
            let qs = &block[4 + K_SCALE_SIZE + QK_K / 8..];
            let base = block_idx * QK_K;

            let mut is = 0;
            let mut u1: u8 = 1;
            let mut u2: u8 = 2;

            for j in (0..QK_K).step_by(64) {
                let (sc1, m1) = Self::get_scale_min_k4_single(scales, is);
                let (sc2, m2) = Self::get_scale_min_k4_single(scales, is + 1);

                let d1 = d * (sc1 as f32);
                let m1_val = dmin * (m1 as f32);
                let d2 = d * (sc2 as f32);
                let m2_val = dmin * (m2 as f32);

                let ql = &qs[j / 2..j / 2 + 32];
                let qh_group = &qh[j / 8..j / 8 + 4];

                for l in 0..32 {
                    let idx = base + j + l;
                    if idx < num_elems {
                        let q_low = (ql[l] & 0x0F) as f32;
                        let high_bit = if (qh_group[l / 8] & u1) != 0 {
                            16.0
                        } else {
                            0.0
                        };
                        floats[idx] = d1 * (q_low + high_bit) - m1_val;
                    }
                }

                for l in 0..32 {
                    let idx = base + j + 32 + l;
                    if idx < num_elems {
                        let q_high = ((ql[l] >> 4) & 0x0F) as f32;
                        let high_bit = if (qh_group[l / 8] & u2) != 0 {
                            16.0
                        } else {
                            0.0
                        };
                        floats[idx] = d2 * (q_high + high_bit) - m2_val;
                    }
                }

                is += 2;
                u1 <<= 2;
                u2 <<= 2;
            }
        }
        Ok(floats)
    }

    fn dequant_q6_k(
        file: &mut std::fs::File,
        num_elems: usize,
    ) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        const QK_K: usize = 256;
        const BLOCK_BYTES: usize = 2 + QK_K / 16 + QK_K / 2 + QK_K / 4;
        let num_blocks = num_elems.div_ceil(QK_K);
        let total_bytes = num_blocks * BLOCK_BYTES;
        let mut block_data = vec![0u8; total_bytes];
        file.read_exact(&mut block_data)?;

        let mut floats = vec![0.0f32; num_elems];
        for block_idx in 0..num_blocks {
            let start = block_idx * BLOCK_BYTES;
            let block = &block_data[start..start + BLOCK_BYTES];
            let d = f16_to_f32(u16::from_le_bytes([block[0], block[1]]));
            let scales = &block[2..2 + QK_K / 16];
            let ql = &block[2 + QK_K / 16..2 + QK_K / 16 + QK_K / 2];
            let qh = &block[2 + QK_K / 16 + QK_K / 2..];
            let base = block_idx * QK_K;

            for idx in 0..QK_K {
                let out_idx = base + idx;
                if out_idx < num_elems {
                    let is = (idx & 0xF0) >> 4;
                    let scale = scales[is] as i8 as f32;

                    let ql_idx = ((idx & 0x80) >> 2) + ((idx & 0x3E) >> 1);
                    let b = (idx & 0x40) >> 6;
                    let ql_val = (ql[ql_idx] >> (b * 4)) & 0x0F;

                    let qh_idx = ((idx & 0x80) >> 3) + ((idx & 0x1E) >> 1);
                    let qhshift = (idx & 0x60) >> 4;
                    let qh_val = ((qh[qh_idx] >> qhshift) & 0x03) << 4;

                    let q = (ql_val | qh_val) as i32 - 32;
                    floats[out_idx] = d * scale * q as f32;
                }
            }
        }
        Ok(floats)
    }

    fn get_scale_min_k4(scales: &[u8]) -> ([u32; 8], [u32; 8]) {
        let mut sc: [u32; 8] = [0; 8];
        let mut mins: [u32; 8] = [0; 8];

        let d = [scales[0], scales[1], scales[2], scales[3]];
        let m = [scales[4], scales[5], scales[6], scales[7]];
        let m_d = [scales[8], scales[9], scales[10], scales[11]];

        for i in 0..4 {
            sc[i] = (d[i] as u32) & 0x3F;
            sc[i + 4] = ((m_d[i] as u32) & 0x0F) | (((d[i] as u32) >> 2) & 0x30);
            mins[i] = (m[i] as u32) & 0x3F;
            mins[i + 4] = ((m_d[i] as u32) >> 4) | (((m[i] as u32) >> 2) & 0x30);
        }

        (sc, mins)
    }

    fn get_scale_min_k4_single(scales: &[u8], idx: usize) -> (u32, u32) {
        let (sc, mins) = Self::get_scale_min_k4(scales);
        (sc[idx], mins[idx])
    }
}

fn f16_to_f32(bits: u16) -> f32 {
    half::f16::from_bits(bits).to_f32()
}
