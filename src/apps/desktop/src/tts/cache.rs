use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

pub const MAGIC: &[u8] = b"TTSC";
pub const VERSION: u32 = 1;

pub fn save_cache(path: &Path, codes: &[i64], emb: &[f32]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(MAGIC)?;
    file.write_all(&VERSION.to_le_bytes())?;

    file.write_all(&codes.len().to_le_bytes())?;
    for &code in codes {
        file.write_all(&code.to_le_bytes())?;
    }

    file.write_all(&emb.len().to_le_bytes())?;
    for &val in emb {
        file.write_all(&val.to_le_bytes())?;
    }

    Ok(())
}

pub fn load_cache(path: &Path) -> io::Result<(Vec<i64>, Vec<f32>)> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid magic bytes",
        ));
    }

    let mut version_bytes = [0u8; 4];
    file.read_exact(&mut version_bytes)?;
    let version = u32::from_le_bytes(version_bytes);
    if version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unsupported version",
        ));
    }

    let mut len_bytes = [0u8; 8];
    file.read_exact(&mut len_bytes)?;
    let codes_len = usize::from_le_bytes(len_bytes);
    let mut codes = Vec::with_capacity(codes_len);
    for _ in 0..codes_len {
        let mut bytes = [0u8; 8];
        file.read_exact(&mut bytes)?;
        codes.push(i64::from_le_bytes(bytes));
    }

    file.read_exact(&mut len_bytes)?;
    let emb_len = usize::from_le_bytes(len_bytes);
    let mut emb = Vec::with_capacity(emb_len);
    for _ in 0..emb_len {
        let mut bytes = [0u8; 4];
        file.read_exact(&mut bytes)?;
        emb.push(f32::from_le_bytes(bytes));
    }

    Ok((codes, emb))
}
