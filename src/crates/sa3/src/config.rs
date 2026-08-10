pub const SAMPLE_RATE: u32 = 44100;
pub const IO_CHANNELS: usize = 256;
pub const AUDIO_ALIGN: usize = 8192;
pub const CROSS_ATTN_SEQ_LEN: usize = 257;
pub const TEXT_MAX_LENGTH: usize = 256;
pub const HEADROOM_SECONDS: f32 = 6.0;

pub const PATCH_SIZE: usize = 256;
pub const AUDIO_CHANNELS: usize = 2;
pub const ENCODER_STRIDE: usize = 16;
pub const DOWNSAMPLING_RATIO: usize = PATCH_SIZE * ENCODER_STRIDE;
pub const PATCHED_CHANNELS: usize = AUDIO_CHANNELS * PATCH_SIZE;
pub const LOCAL_ADD_COND_DIM: usize = IO_CHANNELS + 1;

pub const LOGSNR_ANCHOR_LENGTH: f32 = 2000.0;
pub const LOGSNR_ANCHOR_LOGSNR: f32 = -6.2;
pub const LOGSNR_RATE: f32 = 0.0;
pub const LOGSNR_END: f32 = 2.0;

pub fn compute_latent_len(seconds: f32) -> usize {
    ((seconds + HEADROOM_SECONDS) * SAMPLE_RATE as f32 / AUDIO_ALIGN as f32).ceil() as usize * 2
}
