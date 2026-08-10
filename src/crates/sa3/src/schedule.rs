use crate::config::{LOGSNR_ANCHOR_LENGTH, LOGSNR_ANCHOR_LOGSNR, LOGSNR_END, LOGSNR_RATE};

pub struct LogSNRShift {
    anchor_logsnr: f32,
    rate: f32,
    logsnr_end: f32,
}

impl LogSNRShift {
    pub fn new(anchor_logsnr: f32, rate: f32, logsnr_end: f32) -> Self {
        Self {
            anchor_logsnr,
            rate,
            logsnr_end,
        }
    }

    pub fn default_shift() -> Self {
        Self::new(LOGSNR_ANCHOR_LOGSNR, LOGSNR_RATE, LOGSNR_END)
    }

    pub fn shift(&self, t: f32, seq_len: usize) -> f32 {
        let logsnr_start =
            self.anchor_logsnr - self.rate * (seq_len as f32 / LOGSNR_ANCHOR_LENGTH).log2();
        let logsnr = self.logsnr_end - t * (self.logsnr_end - logsnr_start);
        let t_out = 1.0 / (1.0 + logsnr.exp());
        if t <= 0.0 {
            0.0
        } else if t >= 1.0 {
            1.0
        } else {
            t_out
        }
    }
}

pub fn build_schedule(steps: usize, latent_len: usize) -> Vec<f32> {
    let shift = LogSNRShift::default_shift();
    let mut schedule = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let t = 1.0 - i as f32 / steps as f32;
        schedule.push(shift.shift(t, latent_len));
    }
    schedule
}
