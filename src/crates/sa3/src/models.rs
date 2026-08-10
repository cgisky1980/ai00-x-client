use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use ndarray::{Array2, Array3};
use tokenizers::Tokenizer;

use crate::config::{AUDIO_CHANNELS, IO_CHANNELS, PATCHED_CHANNELS, PATCH_SIZE, TEXT_MAX_LENGTH};

#[cfg(target_os = "windows")]
const BRIDGE_LIB_NAME: &str = "mnn_dit_bridge.dll";
#[cfg(target_os = "linux")]
const BRIDGE_LIB_NAME: &str = "libmnn_dit_bridge.so";
#[cfg(target_os = "macos")]
const BRIDGE_LIB_NAME: &str = "libmnn_dit_bridge.dylib";

fn find_bridge_lib(models_dir: &Path) -> Result<PathBuf> {
    let local = models_dir.join(BRIDGE_LIB_NAME);
    if local.exists() {
        return Ok(local);
    }
    let dll_sub = models_dir.join("dll").join(BRIDGE_LIB_NAME);
    if dll_sub.exists() {
        return Ok(dll_sub);
    }

    if let Some(dir) = option_env!("MNN_LIBS_DIR") {
        let build_lib = Path::new(dir).join(BRIDGE_LIB_NAME);
        if build_lib.exists() {
            return Ok(build_lib);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Check runtime/mnn/{version}/ directory
            let runtime_mnn = exe_dir.join("runtime").join("mnn");
            if let Ok(entries) = std::fs::read_dir(&runtime_mnn) {
                for entry in entries.flatten() {
                    let version_dir = entry.path();
                    let bridge = version_dir.join(BRIDGE_LIB_NAME);
                    if bridge.exists() {
                        return Ok(bridge);
                    }
                }
            }
            // Check exe directory itself
            let exe_lib = exe_dir.join(BRIDGE_LIB_NAME);
            if exe_lib.exists() {
                return Ok(exe_lib);
            }
        }
    }

    // Fallback: try loading by name only (relies on PATH / DLL search path)
    // If the caller has added the MNN directory to PATH, this will work
    log(&format!(
        "  Bridge lib not found in explicit paths, falling back to system search for: {}",
        BRIDGE_LIB_NAME
    ));
    Ok(PathBuf::from(BRIDGE_LIB_NAME))
}

fn log(msg: &str) {
    println!("{msg}");
    let _ = std::io::stdout().flush();
}

#[repr(C)]
struct MNNModelHandle {
    _opaque: [u8; 0],
}

type FnCreate = unsafe extern "system" fn(
    *const std::os::raw::c_char,
    std::os::raw::c_int,
    std::os::raw::c_int,
    std::os::raw::c_int,
) -> *mut MNNModelHandle;
type FnResize = unsafe extern "system" fn(
    *mut MNNModelHandle,
    *const std::os::raw::c_char,
    std::os::raw::c_int,
    *const std::os::raw::c_int,
) -> std::os::raw::c_int;
type FnSetInput = unsafe extern "system" fn(
    *mut MNNModelHandle,
    *const std::os::raw::c_char,
    *const f32,
    std::os::raw::c_int,
) -> std::os::raw::c_int;
type FnSetInputI64 = unsafe extern "system" fn(
    *mut MNNModelHandle,
    *const std::os::raw::c_char,
    *const i64,
    std::os::raw::c_int,
) -> std::os::raw::c_int;
type FnResizeCommit = unsafe extern "system" fn(*mut MNNModelHandle) -> std::os::raw::c_int;
type FnRun = unsafe extern "system" fn(*mut MNNModelHandle) -> std::os::raw::c_int;
type FnRunYielding =
    unsafe extern "system" fn(*mut MNNModelHandle, std::os::raw::c_int) -> std::os::raw::c_int;
type FnGetOutput = unsafe extern "system" fn(
    *mut MNNModelHandle,
    *const std::os::raw::c_char,
    *mut f32,
    std::os::raw::c_int,
) -> std::os::raw::c_int;
type FnGetOutputDims = unsafe extern "system" fn(
    *mut MNNModelHandle,
    *const std::os::raw::c_char,
    *mut std::os::raw::c_int,
    std::os::raw::c_int,
) -> std::os::raw::c_int;
type FnDestroy = unsafe extern "system" fn(*mut MNNModelHandle);

pub(crate) struct MNNModel {
    handle: *mut MNNModelHandle,
    _lib: libloading::Library,
    fn_resize: FnResize,
    fn_resize_commit: FnResizeCommit,
    fn_set_input: FnSetInput,
    fn_set_input_i64: FnSetInputI64,
    fn_run: FnRun,
    fn_run_yielding: Option<FnRunYielding>,
    fn_get_output: FnGetOutput,
    fn_get_output_dims: FnGetOutputDims,
    fn_destroy: FnDestroy,
}

impl MNNModel {
    pub(crate) fn load(
        models_dir: &Path,
        model_file: &str,
        use_gpu: i32,
        threads: i32,
        precision: i32,
    ) -> Result<Self> {
        let bridge_dll = find_bridge_lib(models_dir)?;
        let model_path = models_dir.join(model_file);

        log(&format!(
            "  Loading bridge DLL: {:?} (exists={})",
            bridge_dll,
            bridge_dll.exists()
        ));

        // Pre-load MNN.dll dependency before loading the bridge DLL.
        // On Windows, LoadLibraryExW does not search the DLL's own directory
        // for dependencies unless LOAD_WITH_ALTERED_SEARCH_PATH is used.
        // Pre-loading ensures MNN.dll is already in the process when
        // mnn_dit_bridge.dll tries to resolve it.
        if let Some(bridge_dir) = bridge_dll.parent() {
            let mnn_dll_name = if cfg!(target_os = "windows") {
                "MNN.dll"
            } else if cfg!(target_os = "macos") {
                "libMNN.dylib"
            } else {
                "libMNN.so"
            };
            let mnn_path = bridge_dir.join(mnn_dll_name);
            if mnn_path.exists() {
                log(&format!("  Pre-loading MNN dependency: {:?}", mnn_path));
                let _mnn_lib = unsafe {
                    libloading::Library::new(&mnn_path)
                        .map_err(|e| anyhow!("Failed to pre-load MNN dependency: {e}"))?
                };
                std::mem::forget(_mnn_lib);
            }
        }

        let lib = unsafe {
            libloading::Library::new(&bridge_dll)
                .map_err(|e| anyhow!("Failed to load bridge DLL {:?}: {e}. Ensure MNN.dll is in the same directory or PATH.", bridge_dll))?
        };

        macro_rules! get_fn {
            ($name:expr, $ty:ty) => {
                unsafe {
                    *lib.get::<$ty>($name).map_err(|e| {
                        anyhow!(
                            "Failed to find {}: {e}",
                            std::str::from_utf8($name).unwrap_or("?")
                        )
                    })?
                }
            };
        }

        let fn_create: FnCreate = get_fn!(b"mnn_model_create\0", FnCreate);
        let fn_resize: FnResize = get_fn!(b"mnn_model_resize\0", FnResize);
        let fn_resize_commit: FnResizeCommit =
            get_fn!(b"mnn_model_resize_commit\0", FnResizeCommit);
        let fn_set_input: FnSetInput = get_fn!(b"mnn_model_set_input\0", FnSetInput);
        let fn_set_input_i64: FnSetInputI64 = get_fn!(b"mnn_model_set_input_i64\0", FnSetInputI64);
        let fn_run: FnRun = get_fn!(b"mnn_model_run\0", FnRun);
        let fn_run_yielding: Option<FnRunYielding> = unsafe {
            lib.get::<FnRunYielding>(b"mnn_model_run_yielding\0")
                .ok()
                .map(|ptr| *ptr)
        };
        let fn_get_output: FnGetOutput = get_fn!(b"mnn_model_get_output\0", FnGetOutput);
        let fn_get_output_dims: FnGetOutputDims =
            get_fn!(b"mnn_model_get_output_dims\0", FnGetOutputDims);
        let fn_destroy: FnDestroy = get_fn!(b"mnn_model_destroy\0", FnDestroy);

        let path_cstr = std::ffi::CString::new(
            model_path
                .to_str()
                .ok_or_else(|| anyhow!("Invalid model path"))?,
        )
        .map_err(|e| anyhow!("CString error: {e}"))?;

        let handle = unsafe { fn_create(path_cstr.as_ptr(), use_gpu, threads, precision) };
        if handle.is_null() {
            return Err(anyhow!("MNN model create failed: {}", model_file));
        }

        let backend = match use_gpu {
            1 => "CUDA",
            2 => "Vulkan",
            _ => "CPU",
        };
        let prec_label = if precision == 1 { "High" } else { "Normal" };
        log(&format!(
            "  MNN loaded: {} (backend={}, precision={})",
            model_file, backend, prec_label
        ));

        Ok(Self {
            handle,
            _lib: lib,
            fn_resize,
            fn_resize_commit,
            fn_set_input,
            fn_set_input_i64,
            fn_run,
            fn_run_yielding,
            fn_get_output,
            fn_get_output_dims,
            fn_destroy,
        })
    }

    pub(crate) fn resize(&self, input_name: &str, dims: &[i32]) -> Result<()> {
        let name_cstr =
            std::ffi::CString::new(input_name).map_err(|e| anyhow!("CString error: {e}"))?;
        let ret = unsafe {
            (self.fn_resize)(
                self.handle,
                name_cstr.as_ptr(),
                dims.len() as i32,
                dims.as_ptr(),
            )
        };
        if ret != 0 {
            return Err(anyhow!("MNN resize '{}' failed: {}", input_name, ret));
        }
        Ok(())
    }

    pub(crate) fn resize_commit(&self) -> Result<()> {
        let ret = unsafe { (self.fn_resize_commit)(self.handle) };
        if ret != 0 {
            return Err(anyhow!("MNN resize_commit failed: {}", ret));
        }
        Ok(())
    }

    pub(crate) fn set_input(&self, input_name: &str, data: &[f32]) -> Result<()> {
        let name_cstr =
            std::ffi::CString::new(input_name).map_err(|e| anyhow!("CString error: {e}"))?;
        log(&format!(
            "    [MNN] set_input '{}' count={}",
            input_name,
            data.len()
        ));
        let ret = unsafe {
            (self.fn_set_input)(
                self.handle,
                name_cstr.as_ptr(),
                data.as_ptr(),
                data.len() as i32,
            )
        };
        if ret != 0 {
            return Err(anyhow!("MNN set_input '{}' failed: {}", input_name, ret));
        }
        Ok(())
    }

    fn set_input_i64(&self, input_name: &str, data: &[i64]) -> Result<()> {
        let name_cstr =
            std::ffi::CString::new(input_name).map_err(|e| anyhow!("CString error: {e}"))?;
        let ret = unsafe {
            (self.fn_set_input_i64)(
                self.handle,
                name_cstr.as_ptr(),
                data.as_ptr(),
                data.len() as i32,
            )
        };
        if ret != 0 {
            return Err(anyhow!(
                "MNN set_input_i64 '{}' failed: {}",
                input_name,
                ret
            ));
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn run(&self) -> Result<()> {
        let ret = unsafe { (self.fn_run)(self.handle) };
        if ret != 0 {
            return Err(anyhow!("MNN run failed: {}", ret));
        }
        Ok(())
    }

    /// Run model with yielding between operators to reduce CPU monopolization.
    /// Falls back to regular run if yielding version is not available.
    pub(crate) fn run_yielding(&self, yield_interval: i32) -> Result<()> {
        if let Some(fn_yield) = self.fn_run_yielding {
            let ret = unsafe { (fn_yield)(self.handle, yield_interval) };
            if ret != 0 {
                return Err(anyhow!("MNN run_yielding failed: {}", ret));
            }
        } else {
            // Fallback to regular run + yield
            let ret = unsafe { (self.fn_run)(self.handle) };
            if ret != 0 {
                return Err(anyhow!("MNN run failed: {}", ret));
            }
            std::thread::yield_now();
        }
        Ok(())
    }

    pub(crate) fn get_output_array3(&self, output_name: &str) -> Result<Array3<f32>> {
        let name_cstr =
            std::ffi::CString::new(output_name).map_err(|e| anyhow!("CString error: {e}"))?;
        log(&format!("    [MNN] get_output '{}'...", output_name));

        let mut dims = [0i32; 8];
        let ndim = unsafe {
            (self.fn_get_output_dims)(self.handle, name_cstr.as_ptr(), dims.as_mut_ptr(), 8)
        };
        if ndim < 0 {
            return Err(anyhow!("MNN get_output_dims failed: {}", ndim));
        }

        let mut total = 1i32;
        for &d in dims.iter().take(ndim as usize) {
            total *= d;
        }

        let mut out = vec![0.0f32; total as usize];
        let actual = unsafe {
            (self.fn_get_output)(self.handle, name_cstr.as_ptr(), out.as_mut_ptr(), total)
        };
        if actual < 0 {
            return Err(anyhow!("MNN get_output failed: {}", actual));
        }

        if ndim != 3 {
            return Err(anyhow!("Expected 3D output, got {}D", ndim));
        }

        Array3::from_shape_vec((dims[0] as usize, dims[1] as usize, dims[2] as usize), out)
            .map_err(|e| anyhow!("Failed to reshape output: {e}"))
    }
}

impl Drop for MNNModel {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.fn_destroy)(self.handle) };
        }
    }
}

// NOTE: MNNModel must NOT be Send - MNN stores thread-local/GPU context state.
// The AudioGen worker thread ensures MNN models are always used on the same
// thread they were created on. If you need cross-thread usage, use a channel-based
// worker pattern (see model_init.rs start_audio_gen_worker).

struct SoftNormBottleneck {
    scaling_factor: Array3<f32>,
    bias: Array3<f32>,
    running_std: f32,
}

impl SoftNormBottleneck {
    fn load(models_dir: &Path) -> Result<Self> {
        let params_path = models_dir.join("bottleneck_params.json");
        if !params_path.exists() {
            return Err(anyhow!("bottleneck_params.json not found"));
        }
        let json_str = std::fs::read_to_string(&params_path)
            .map_err(|e| anyhow!("Failed to read bottleneck params: {e}"))?;
        let params: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| anyhow!("Failed to parse bottleneck params: {e}"))?;

        let sf = params["scaling_factor"]
            .as_array()
            .ok_or_else(|| anyhow!("Missing scaling_factor"))?;
        let sf_inner = sf[0]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid scaling_factor shape"))?;
        let sf_data: Vec<f32> = sf_inner
            .iter()
            .map(|v| v.as_array().unwrap()[0].as_f64().unwrap() as f32)
            .collect();
        let scaling_factor = Array3::from_shape_vec((1, IO_CHANNELS, 1), sf_data)
            .map_err(|e| anyhow!("Failed to reshape scaling_factor: {e}"))?;

        let b = params["bias"]
            .as_array()
            .ok_or_else(|| anyhow!("Missing bias"))?;
        let b_inner = b[0]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid bias shape"))?;
        let b_data: Vec<f32> = b_inner
            .iter()
            .map(|v| v.as_array().unwrap()[0].as_f64().unwrap() as f32)
            .collect();
        let bias = Array3::from_shape_vec((1, IO_CHANNELS, 1), b_data)
            .map_err(|e| anyhow!("Failed to reshape bias: {e}"))?;

        let running_std = params["running_std"]
            .as_array()
            .and_then(|arr| arr[0].as_f64())
            .unwrap_or(1.0) as f32;

        log(&format!(
            "  SoftNormBottleneck loaded (running_std={running_std:.6})"
        ));

        Ok(Self {
            scaling_factor,
            bias,
            running_std,
        })
    }

    fn encode(&self, x: &Array3<f32>) -> Array3<f32> {
        let mut result = x * &self.scaling_factor + &self.bias;
        if self.running_std.abs() > 1e-8 {
            result.mapv_inplace(|v| v / self.running_std);
        }
        result
    }
}

fn patched_pretransform_encode(audio: &Array3<f32>) -> Array3<f32> {
    let (_batch, _channels, t_audio) = audio.dim();
    let t_padded = t_audio.div_ceil(PATCH_SIZE) * PATCH_SIZE;

    let mut padded = Array3::zeros((1, AUDIO_CHANNELS, t_padded));
    for c in 0..AUDIO_CHANNELS {
        for t in 0..t_audio.min(t_padded) {
            padded[[0, c, t]] = audio[[0, c, t]];
        }
    }

    let n_patches = t_padded / PATCH_SIZE;
    let mut result = Array3::zeros((1, PATCHED_CHANNELS, n_patches));
    for p in 0..n_patches {
        for c in 0..AUDIO_CHANNELS {
            for h in 0..PATCH_SIZE {
                result[[0, c * PATCH_SIZE + h, p]] = padded[[0, c, p * PATCH_SIZE + h]];
            }
        }
    }
    result
}

struct VariantModels {
    nc_mnn: MNNModel,
    dit_mnn: MNNModel,
    dit_t_lat: usize,
}

pub struct StableAudio3Models {
    t5_mnn: Option<MNNModel>,
    music: Option<VariantModels>,
    sfx: Option<VariantModels>,
    dec_mnn: Option<MNNModel>,
    dec_t_lat: usize,
    encoder_mnn: Option<MNNModel>,
    bottleneck: Option<SoftNormBottleneck>,
    tokenizer: Tokenizer,
}

impl StableAudio3Models {
    #[allow(clippy::too_many_arguments)]
    pub fn load(
        models_dir: &Path,
        variant: &str,
        mnn_gpu: i32,
        mnn_int8: bool,
        mnn_fp32: bool,
        mnn_t5_fp32: bool,
        t_lat: usize,
    ) -> Result<Self> {
        let mnn_precision: i32 = if mnn_fp32 { 1 } else { 0 };

        let t5_mnn = {
            let t0 = std::time::Instant::now();
            let t5_file = if mnn_t5_fp32 {
                "text_encoder.mnn"
            } else {
                "text_encoder_int4.mnn"
            };
            log(&format!("  Loading T5 (MNN CPU): {t5_file}..."));
            let m = MNNModel::load(models_dir, t5_file, 0, 12, mnn_precision)?;
            log(&format!(
                "    T5 load time: {:.2}s",
                t0.elapsed().as_secs_f32()
            ));
            Some(m)
        };

        // Load variant-specific models (NC + DiT) for both music and sfx
        let load_variant = |variant_key: &str| -> Result<VariantModels> {
            let nc_mnn = {
                let t0 = std::time::Instant::now();
                log(&format!("  Loading NC-{variant_key} (MNN)..."));
                let name = if mnn_int8 {
                    format!("number_conditioner_{variant_key}_int8.mnn")
                } else {
                    format!("number_conditioner_{variant_key}_fp16.mnn")
                };
                let m = MNNModel::load(models_dir, &name, mnn_gpu, 12, mnn_precision)?;
                log(&format!(
                    "    NC-{variant_key} load time: {:.2}s",
                    t0.elapsed().as_secs_f32()
                ));
                m
            };
            let dit_mnn = {
                let t0 = std::time::Instant::now();
                log(&format!("  Loading DiT-{variant_key} (MNN)..."));
                let name = if mnn_int8 {
                    format!("dit_{variant_key}_int8.mnn")
                } else {
                    let p1 = models_dir.join(format!("dit_{variant_key}_fp16_f32io.mnn"));
                    if p1.exists() {
                        format!("dit_{variant_key}_fp16_f32io.mnn")
                    } else {
                        format!("dit_{variant_key}_fp16_v2_f32io.mnn")
                    }
                };
                let m = MNNModel::load(models_dir, &name, mnn_gpu, 12, mnn_precision)?;
                m.resize("x", &[1, 256, t_lat as i32])?;
                m.resize("cross_attn_cond", &[1, 257, 768])?;
                m.resize("global_embed", &[1, 768])?;
                m.resize("local_add_cond", &[1, 257, t_lat as i32])?;
                m.resize("padding_mask", &[1, t_lat as i32])?;
                m.resize_commit()?;
                log(&format!(
                    "    DiT-{variant_key} load time: {:.2}s",
                    t0.elapsed().as_secs_f32()
                ));
                m
            };
            Ok(VariantModels {
                nc_mnn,
                dit_mnn,
                dit_t_lat: t_lat,
            })
        };

        // Load music variant (primary)
        let primary_key = variant.replace("sm-", "");
        let music = load_variant(&primary_key).ok();

        // Load sfx variant if different from primary
        let sfx = if primary_key != "sfx" {
            load_variant("sfx").ok()
        } else {
            None
        };

        let dec_mnn = {
            let t0 = std::time::Instant::now();
            log("  Loading Decoder (MNN FusedWN)...");
            let m = MNNModel::load(
                models_dir,
                "decoder_fused_wn.mnn",
                mnn_gpu,
                12,
                mnn_precision,
            )?;
            m.resize("latents", &[1, 256, 256])?;
            m.resize_commit()?;
            log(&format!(
                "    Decoder load time: {:.2}s",
                t0.elapsed().as_secs_f32()
            ));
            Some(m)
        };
        let dec_t_lat = 256; // Initial resize at load time
        let (encoder_mnn, bottleneck) = {
            let enc_name = if mnn_int8 {
                "encoder_int8.mnn"
            } else {
                "encoder.mnn"
            };
            let enc_path = models_dir.join(enc_name);
            let bn_path = models_dir.join("bottleneck_params.json");
            if enc_path.exists() && bn_path.exists() {
                let t0 = std::time::Instant::now();
                log(&format!("  Loading Encoder (MNN): {enc_name}..."));
                let m = MNNModel::load(models_dir, enc_name, mnn_gpu, 12, mnn_precision)?;
                let bn = SoftNormBottleneck::load(models_dir)?;
                log(&format!(
                    "    Encoder load time: {:.2}s",
                    t0.elapsed().as_secs_f32()
                ));
                (Some(m), Some(bn))
            } else {
                log("  Encoder model not found, skipping (music-to-music mode unavailable)");
                (None, None)
            }
        };
        let tokenizer = {
            let tok_path = models_dir.join("tokenizer.json");
            log(&format!("  Loading Tokenizer: {}", tok_path.display()));
            Tokenizer::from_file(&tok_path).map_err(|e| anyhow!("Failed to load tokenizer: {e}"))?
        };
        let t5_label = if mnn_t5_fp32 {
            "MNN-CPU"
        } else {
            "MNN-CPU-INT4"
        };
        let mnn_label = if mnn_int8 { "MNN-INT8" } else { "MNN" };
        log(&format!(
            "  All models loaded (T5={t5_label}, NC/DiT/Decoder={mnn_label})"
        ));
        Ok(Self {
            t5_mnn,
            music,
            sfx,
            dec_mnn,
            dec_t_lat,
            encoder_mnn,
            bottleneck,
            tokenizer,
        })
    }

    pub fn encode_text(&mut self, text: &str) -> Result<(Array3<f32>, Array2<i64>)> {
        let (ids, mask) = if text.trim().is_empty() {
            let ids = Array2::zeros((1, TEXT_MAX_LENGTH));
            let mask = Array2::zeros((1, TEXT_MAX_LENGTH));
            (ids, mask)
        } else {
            let enc = self
                .tokenizer
                .encode(text, true)
                .map_err(|e| anyhow!("Tokenization failed: {e}"))?;
            let token_ids = enc.get_ids();
            let len = token_ids.len().min(TEXT_MAX_LENGTH);
            let mut ids = Array2::zeros((1, TEXT_MAX_LENGTH));
            let mut mask = Array2::zeros((1, TEXT_MAX_LENGTH));
            for i in 0..len {
                ids[[0, i]] = token_ids[i] as i64;
                mask[[0, i]] = 1;
            }
            (ids, mask)
        };

        if let Some(ref mnn) = self.t5_mnn {
            let ids_flat: Vec<i64> = ids.iter().copied().collect();
            let mask_flat: Vec<i64> = mask.iter().copied().collect();
            mnn.set_input_i64("input_ids", &ids_flat)?;
            mnn.set_input_i64("attention_mask", &mask_flat)?;
            mnn.run_yielding(3)?;
            let hidden = mnn.get_output_array3("last_hidden_state")?;
            Ok((hidden, mask))
        } else {
            Err(anyhow!("T5 model not loaded"))
        }
    }

    pub fn encode_seconds(&mut self, seconds: f32, variant: &str) -> Result<Array3<f32>> {
        let vm = self.variant_models(variant)?;
        vm.nc_mnn.set_input("seconds", &[seconds])?;
        vm.nc_mnn.run_yielding(3)?;
        vm.nc_mnn.get_output_array3("embedding")
    }

    #[allow(clippy::too_many_arguments)]
    pub fn run_dit(
        &mut self,
        x: &Array3<f32>,
        t: f32,
        cross_attn_cond: &Array3<f32>,
        global_embed: &Array2<f32>,
        local_add_cond: &Array3<f32>,
        padding_mask: &Array2<bool>,
        variant: &str,
    ) -> Result<Array3<f32>> {
        let vm = self.variant_models_mut(variant)?;

        // Check if DiT needs resize for current t_lat
        let cur_t_lat = x.shape()[2];
        if cur_t_lat != vm.dit_t_lat {
            log(&format!(
                "  [DiT-{variant}] Resizing from t_lat={} to t_lat={}",
                vm.dit_t_lat, cur_t_lat
            ));
            vm.dit_mnn.resize("x", &[1, 256, cur_t_lat as i32])?;
            vm.dit_mnn.resize("cross_attn_cond", &[1, 257, 768])?;
            vm.dit_mnn.resize("global_embed", &[1, 768])?;
            vm.dit_mnn
                .resize("local_add_cond", &[1, 257, cur_t_lat as i32])?;
            vm.dit_mnn.resize("padding_mask", &[1, cur_t_lat as i32])?;
            vm.dit_mnn.resize_commit()?;
            vm.dit_t_lat = cur_t_lat;
        }

        let mask_f32: Vec<f32> = padding_mask
            .iter()
            .map(|&b| if b { 1.0f32 } else { 0.0f32 })
            .collect();

        vm.dit_mnn.set_input("x", x.as_slice().unwrap())?;
        vm.dit_mnn.set_input("t", &[t])?;
        vm.dit_mnn
            .set_input("cross_attn_cond", cross_attn_cond.as_slice().unwrap())?;
        vm.dit_mnn
            .set_input("global_embed", global_embed.as_slice().unwrap())?;
        vm.dit_mnn
            .set_input("local_add_cond", local_add_cond.as_slice().unwrap())?;
        vm.dit_mnn.set_input("padding_mask", &mask_f32)?;
        // Use yielding run to reduce GPU driver DPC stacking
        vm.dit_mnn.run_yielding(3)?;
        vm.dit_mnn.get_output_array3("out")
    }

    fn variant_models(&self, variant: &str) -> Result<&VariantModels> {
        let variant_key = variant.replace("sm-", "");
        match variant_key.as_str() {
            "sfx" => self
                .sfx
                .as_ref()
                .ok_or_else(|| anyhow!("SFX variant models not loaded")),
            _ => self
                .music
                .as_ref()
                .ok_or_else(|| anyhow!("Music variant models not loaded")),
        }
    }

    fn variant_models_mut(&mut self, variant: &str) -> Result<&mut VariantModels> {
        let variant_key = variant.replace("sm-", "");
        match variant_key.as_str() {
            "sfx" => self
                .sfx
                .as_mut()
                .ok_or_else(|| anyhow!("SFX variant models not loaded")),
            _ => self
                .music
                .as_mut()
                .ok_or_else(|| anyhow!("Music variant models not loaded")),
        }
    }

    pub fn decode(&mut self, latents: &Array3<f32>) -> Result<Array3<f32>> {
        let mnn = self
            .dec_mnn
            .as_ref()
            .ok_or_else(|| anyhow!("Decoder model not loaded"))?;
        let t_lat = latents.shape()[2];
        let chunk_size = 256;
        if t_lat <= chunk_size {
            if t_lat != self.dec_t_lat {
                log(&format!(
                    "  [Decoder] Resizing from t_lat={} to t_lat={}",
                    self.dec_t_lat, t_lat
                ));
                mnn.resize("latents", &[1, 256, t_lat as i32])?;
                mnn.resize_commit()?;
                self.dec_t_lat = t_lat;
            }
            mnn.set_input("latents", latents.as_slice().unwrap())?;
            mnn.run_yielding(3)?;
            mnn.get_output_array3("audio")
        } else {
            // For t_lat > chunk_size, ensure decoder is resized to chunk_size for chunked decoding
            if self.dec_t_lat != chunk_size {
                log(&format!(
                    "  [Decoder] Resizing from t_lat={} to chunk_size={}",
                    self.dec_t_lat, chunk_size
                ));
                mnn.resize("latents", &[1, 256, chunk_size as i32])?;
                mnn.resize_commit()?;
                self.dec_t_lat = chunk_size;
            }
            let n_chunks = t_lat.div_ceil(chunk_size);
            let audio_len = t_lat * 4096;
            let mut audio_out = Array3::zeros((1, 2, audio_len));

            for ci in 0..n_chunks {
                // Yield between decode chunks to allow GPU driver DPC processing
                std::thread::yield_now();

                let start = ci * chunk_size;
                let end = (start + chunk_size).min(t_lat);
                let chunk_t = end - start;

                let mut chunk_latent = Array3::zeros((1, 256, chunk_size));
                for c in 0..256 {
                    for t in 0..chunk_t {
                        chunk_latent[[0, c, t]] = latents[[0, c, start + t]];
                    }
                }

                mnn.set_input("latents", chunk_latent.as_slice().unwrap())?;
                mnn.run_yielding(3)?;
                let chunk_audio = mnn.get_output_array3("audio")?;

                let audio_start = start * 4096;
                let audio_chunk_len = chunk_audio.shape()[2].min(chunk_t * 4096);
                let copy_len = audio_chunk_len.min(audio_len - audio_start);
                for ch in 0..2 {
                    for t in 0..copy_len {
                        audio_out[[0, ch, audio_start + t]] = chunk_audio[[0, ch, t]];
                    }
                }
            }

            Ok(audio_out)
        }
    }

    pub fn decode_chunks<F>(
        &mut self,
        latents: &Array3<f32>,
        mut on_chunk: F,
    ) -> Result<Array3<f32>>
    where
        F: FnMut(usize, usize, &Array3<f32>),
    {
        let mnn = self
            .dec_mnn
            .as_ref()
            .ok_or_else(|| anyhow!("Decoder model not loaded"))?;
        let t_lat = latents.shape()[2];
        let chunk_size = 256;
        if t_lat <= chunk_size {
            if t_lat != self.dec_t_lat {
                mnn.resize("latents", &[1, 256, t_lat as i32])?;
                mnn.resize_commit()?;
                self.dec_t_lat = t_lat;
            }
            mnn.set_input("latents", latents.as_slice().unwrap())?;
            mnn.run_yielding(3)?;
            let audio = mnn.get_output_array3("audio")?;
            on_chunk(1, 1, &audio);
            Ok(audio)
        } else {
            // For t_lat > chunk_size, ensure decoder is resized to chunk_size for chunked decoding
            if self.dec_t_lat != chunk_size {
                mnn.resize("latents", &[1, 256, chunk_size as i32])?;
                mnn.resize_commit()?;
                self.dec_t_lat = chunk_size;
            }
            let n_chunks = t_lat.div_ceil(chunk_size);
            let audio_len = t_lat * 4096;
            let mut audio_out = Array3::zeros((1, 2, audio_len));

            for ci in 0..n_chunks {
                // Yield between decode chunks to allow GPU driver DPC processing
                std::thread::yield_now();

                let start = ci * chunk_size;
                let end = (start + chunk_size).min(t_lat);
                let chunk_t = end - start;

                let mut chunk_latent = Array3::zeros((1, 256, chunk_size));
                for c in 0..256 {
                    for t in 0..chunk_t {
                        chunk_latent[[0, c, t]] = latents[[0, c, start + t]];
                    }
                }

                mnn.set_input("latents", chunk_latent.as_slice().unwrap())?;
                mnn.run_yielding(3)?;
                let chunk_audio = mnn.get_output_array3("audio")?;

                let audio_start = start * 4096;
                let audio_chunk_len = chunk_audio.shape()[2].min(chunk_t * 4096);
                let copy_len = audio_chunk_len.min(audio_len - audio_start);
                let mut chunk_trimmed = Array3::zeros((1, 2, copy_len));
                for ch in 0..2 {
                    for t in 0..copy_len {
                        audio_out[[0, ch, audio_start + t]] = chunk_audio[[0, ch, t]];
                        chunk_trimmed[[0, ch, t]] = chunk_audio[[0, ch, t]];
                    }
                }

                on_chunk(ci + 1, n_chunks, &chunk_trimmed);
            }

            Ok(audio_out)
        }
    }

    pub fn encode_audio(&mut self, audio: &Array3<f32>) -> Result<Array3<f32>> {
        let encoder = self
            .encoder_mnn
            .as_mut()
            .ok_or_else(|| anyhow!("Encoder not loaded (music-to-music mode unavailable)"))?;
        let bottleneck = self
            .bottleneck
            .as_ref()
            .ok_or_else(|| anyhow!("Bottleneck not loaded"))?;

        let patched = patched_pretransform_encode(audio);
        let t_patched = patched.shape()[2] as i32;

        encoder.resize("patched_audio", &[1, PATCHED_CHANNELS as i32, t_patched])?;
        encoder.resize_commit()?;

        encoder.set_input("patched_audio", patched.as_slice().unwrap())?;
        encoder.run_yielding(3)?;
        let encoder_out = encoder.get_output_array3("encoder_latent")?;

        let latent = bottleneck.encode(&encoder_out);

        Ok(latent)
    }

    pub fn has_encoder(&self) -> bool {
        self.encoder_mnn.is_some() && self.bottleneck.is_some()
    }
}
