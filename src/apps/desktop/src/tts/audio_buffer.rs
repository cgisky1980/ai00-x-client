use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub struct AudioBuffer {
    buffer: Box<[f32]>,
    capacity: usize,
    write_pos: AtomicUsize,
    read_pos: AtomicUsize,
    available: AtomicUsize,
    stopped: AtomicBool,
}

impl AudioBuffer {
    pub fn new(capacity_seconds: f32, sample_rate: u32) -> Self {
        let capacity = (sample_rate as f32 * capacity_seconds) as usize;
        let capacity = capacity.next_power_of_two();
        Self {
            buffer: vec![0.0f32; capacity].into_boxed_slice(),
            capacity,
            write_pos: AtomicUsize::new(0),
            read_pos: AtomicUsize::new(0),
            available: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn write(&self, samples: &[f32]) -> usize {
        if self.stopped.load(Ordering::Relaxed) {
            return 0;
        }
        let mut written = 0usize;
        let write_pos = self.write_pos.load(Ordering::Relaxed);
        for &sample in samples {
            let avail = self.available.load(Ordering::Relaxed);
            if avail >= self.capacity {
                break;
            }
            unsafe {
                let ptr = self.buffer.as_ptr() as *mut f32;
                *ptr.add(write_pos.wrapping_add(written) % self.capacity) = sample;
            }
            written += 1;
            self.available.fetch_add(1, Ordering::Relaxed);
        }
        if written > 0 {
            self.write_pos.store(
                write_pos.wrapping_add(written) % self.capacity,
                Ordering::Relaxed,
            );
        }
        written
    }

    pub fn read(&self, output: &mut [f32]) -> usize {
        let mut read_count = 0usize;
        let read_pos = self.read_pos.load(Ordering::Relaxed);
        for out in output.iter_mut() {
            let avail = self.available.load(Ordering::Relaxed);
            if avail == 0 {
                break;
            }
            unsafe {
                let ptr = self.buffer.as_ptr();
                *out = *ptr.add(read_pos.wrapping_add(read_count) % self.capacity);
            }
            read_count += 1;
            self.available.fetch_sub(1, Ordering::Relaxed);
        }
        if read_count > 0 {
            self.read_pos.store(
                read_pos.wrapping_add(read_count) % self.capacity,
                Ordering::Relaxed,
            );
        }
        read_count
    }

    pub fn clear(&self) {
        self.write_pos.store(0, Ordering::Relaxed);
        self.read_pos.store(0, Ordering::Relaxed);
        self.available.store(0, Ordering::Relaxed);
    }

    pub fn available(&self) -> usize {
        self.available.load(Ordering::Relaxed)
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.stopped.store(false, Ordering::Relaxed);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

pub fn create_audio_buffer(capacity_seconds: f32) -> Arc<AudioBuffer> {
    Arc::new(AudioBuffer::new(capacity_seconds, 24000))
}
