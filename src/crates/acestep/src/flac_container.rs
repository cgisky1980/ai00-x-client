//! FLAC preview container format (v5) — shareable `.flac` files with an
//! embedded AES-256 encrypted ZIP carrying the "rest" of the song.
//!
//! ## Format overview
//!
//! A shareable file is a **standard FLAC stream** that any conforming FLAC
//! player can decode (hearing only the preview + trailer). The "rest" of
//! the song (everything after the preview) is encoded as a separate FLAC
//! stream, encrypted as an AES-256 ZIP, and embedded in an
//! `APPLICATION` metadata block with `application_id = "A00X"`.
//!
//! ```text
//! ┌─────────────────────────── FLAC stream ───────────────────────────┐
//! │ "fLaC"                                                            │
//! │ STREAMINFO  (preview_duration + trailer_duration samples)         │
//! │ ...other metadata...                                              │
//! │ APPLICATION block  (id="A00X", data = A00MPayload)   ◀── embed    │
//! │ Audio frames  ← preview PCM (60s) + trailer PCM (~5s)             │
//! └───────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## A00MPayload layout (v5)
//!
//! ```text
//! Offset  Length  Field
//! ------  ------  -----
//! 0       4       magic = "A00M"
//! 4       1       version = 0x50 ('P' ASCII, v5.x)
//! 5       1       password_version (u8)
//! 6       8       author_member_id (i64 LE) — copyright record
//! 14      16      share_id (UUID, all-zero if not yet registered)
//! 30      8       created_at_unix (i64 LE)
//! 38      4       encrypted_zip_len (u32 LE)
//! 42      var     encrypted_zip (AES-256 ZIP containing rest.flac)
//! ```
//!
//! Total fixed header = 42 bytes + variable-length `encrypted_zip`.
//!
//! ## Security model
//!
//! - **Standard players** ignore the APPLICATION block (per FLAC spec) and
//!   play only the visible portion (preview + trailer). Users get a
//!   60-second preview followed by a "trial ended" prompt.
//! - **Our player** reads the APPLICATION block, looks up the password for
//!   `password_version` in [`crate::passwords`], decrypts the ZIP,
//!   decodes `rest.flac`, and plays the full song seamlessly.
//! - **Password rotation**: each client release embeds a new password in
//!   [`crate::passwords::PASSWORDS`]. New files use the latest password;
//!   old files remain decryptable via the historical password entries.
//!
//! ## Copyright record
//!
//! Every payload carries `author_member_id` + `share_id` + `created_at_unix`
//! as a tamper-evident copyright record. The `share_id` is zeroed at
//! packaging time and filled in by the server when the file is registered
//! (via [`fill_share_id_in_place`]). Modifying any of these fields would
//! require re-encrypting the entire payload, which is infeasible without
//! the password.

use std::io::{Read, Write};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

use crate::chunked_crypto;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/// FLAC stream magic ("fLaC").
const FLAC_MAGIC: [u8; 4] = *b"fLaC";

/// APPLICATION block application_id — "A00X" = 0x41303058.
///
/// Stored as the first 4 bytes of an APPLICATION block's data section,
/// per FLAC specification.
pub const A00X_APPLICATION_ID: [u8; 4] = *b"A00X";

/// Magic at the start of every A00MPayload (inside the APPLICATION block
/// data, after the 4-byte `application_id`).
pub const A00M_PAYLOAD_MAGIC: [u8; 4] = *b"A00M";

/// A00MPayload version byte (v5.x). Stored as a single byte at offset 4.
pub const A00M_PAYLOAD_VERSION: u8 = 0x50; // 'P' ASCII

/// Fixed-length portion of the A00MPayload v0x50 header (before `encrypted_zip`).
const A00M_PAYLOAD_HEADER_LEN: usize = 42;

/// Fixed-length portion of the A00MPayload v0x51 header (magic + version +
/// password_version + author_member_id + share_id + created_at_unix +
/// chunk_size + block_count + real_block_count + decoy_ratio_permil + reserved).
///
/// The v0x51 payload layout is: header(54) + index_table(N*36) + ciphertext_region.
const A00M_PAYLOAD_HEADER_LEN_V51: usize = 54;

/// FLAC metadata block type for APPLICATION blocks.
const FLAC_BLOCK_TYPE_APPLICATION: u8 = 2;

/// Name of the entry inside the encrypted ZIP that holds the rest FLAC.
const REST_FLAC_ENTRY_NAME: &str = "rest.flac";

/// Default preview duration in seconds (used when caller passes None).
pub const DEFAULT_PREVIEW_DURATION_SECS: f32 = 60.0;

/// Bit depth used for FLAC encoding (matches `package::FLAC_BITS_PER_SAMPLE`).
#[cfg(test)]
const FLAC_BITS_PER_SAMPLE: u32 = 16;

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/// In-memory representation of an A00MPayload (the data inside the
/// APPLICATION block, excluding the 4-byte `application_id` prefix).
///
/// Discriminated by the version byte at offset 4. See [`A00MPayload::V50`]
/// (v0x50, AES-256 ZIP) and [`A00MPayload::V51`] (v0x51, chunked AEAD).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum A00MPayload {
    /// v5.0: AES-256 ZIP whole-file encryption (backward-compatible).
    V50(V50Payload),
    /// v5.1: chunked AEAD encryption + decoy blocks + algorithm rotation.
    V51(V51Payload),
}

/// v5.0 payload fields (AES-256 ZIP whole-file encryption).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V50Payload {
    /// Password version used to encrypt `encrypted_zip`.
    pub password_version: u8,
    /// Author member ID — copyright record (who created this share).
    pub author_member_id: i64,
    /// Share ID (UUID). All zeros means "not yet registered with server".
    pub share_id: [u8; 16],
    /// Unix timestamp (seconds) when the file was packaged.
    pub created_at_unix: i64,
    /// Encrypted ZIP bytes containing `rest.flac`.
    pub encrypted_zip: Vec<u8>,
}

/// v5.1 payload fields (chunked AEAD encryption).
///
/// See [`crate::chunked_crypto`] for the security model (algorithm rotation,
/// per-block HKDF, decoy blocks, AAD design).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V51Payload {
    pub password_version: u8,
    pub author_member_id: i64,
    pub share_id: [u8; 16],
    pub created_at_unix: i64,
    pub chunk_size: u32,
    pub block_count: u32,
    pub real_block_count: u32,
    pub decoy_ratio_permil: u16,
    /// Block index table (entries ordered by `offset` ascending).
    pub index: chunked_crypto::ChunkIndex,
    /// Concatenated ciphertext+tag bytes for all blocks (real + decoy).
    pub ciphertext_region: Vec<u8>,
}

/// Copyright info extracted from an A00MPayload (no secret material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyrightInfo {
    pub password_version: u8,
    pub author_member_id: i64,
    pub share_id: [u8; 16],
    pub created_at_unix: i64,
}

impl From<&A00MPayload> for CopyrightInfo {
    fn from(p: &A00MPayload) -> Self {
        match p {
            A00MPayload::V50(v) => Self {
                password_version: v.password_version,
                author_member_id: v.author_member_id,
                share_id: v.share_id,
                created_at_unix: v.created_at_unix,
            },
            A00MPayload::V51(v) => Self {
                password_version: v.password_version,
                author_member_id: v.author_member_id,
                share_id: v.share_id,
                created_at_unix: v.created_at_unix,
            },
        }
    }
}

// ----------------------------------------------------------------------------
// A00MPayload serialization
// ----------------------------------------------------------------------------

/// Serialize an [`A00MPayload`] to bytes (version-dispatched).
///
/// Layout: see [`A00MPayload::V50`] / [`A00MPayload::V51`] docs.
fn serialize_payload(payload: &A00MPayload) -> Vec<u8> {
    match payload {
        A00MPayload::V50(v) => serialize_payload_v50(v),
        A00MPayload::V51(v) => serialize_payload_v51(v),
    }
}

/// Serialize a v0x50 payload (header + encrypted_zip).
fn serialize_payload_v50(payload: &V50Payload) -> Vec<u8> {
    let mut buf = Vec::with_capacity(A00M_PAYLOAD_HEADER_LEN + payload.encrypted_zip.len());
    buf.extend_from_slice(&A00M_PAYLOAD_MAGIC); // [0..4]
    buf.push(A00M_PAYLOAD_VERSION); // [4]
    buf.push(payload.password_version); // [5]
    buf.extend_from_slice(&payload.author_member_id.to_le_bytes()); // [6..14]
    buf.extend_from_slice(&payload.share_id); // [14..30]
    buf.extend_from_slice(&payload.created_at_unix.to_le_bytes()); // [30..38]
    let zip_len = u32::try_from(payload.encrypted_zip.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&zip_len.to_le_bytes()); // [38..42]
    buf.extend_from_slice(&payload.encrypted_zip); // [42..]
    buf
}

/// Serialize a v0x51 payload (header + index_table + ciphertext_region).
///
/// Header layout (54 bytes):
/// ```text
/// [0..4]   magic "A00M"
/// [4]      version = 0x51
/// [5]      password_version
/// [6..14]  author_member_id (i64 LE)
/// [14..30] share_id (16 bytes — same offset as v0x50, for fill_share_id_in_place compat)
/// [30..38] created_at_unix (i64 LE)
/// [38..42] chunk_size (u32 LE)
/// [42..46] block_count (u32 LE)
/// [46..50] real_block_count (u32 LE)
/// [50..52] decoy_ratio_permil (u16 LE)
/// [52..54] reserved (2 bytes, zero)
/// ```
fn serialize_payload_v51(payload: &V51Payload) -> Vec<u8> {
    let index_bytes = chunked_crypto::serialize_index(&payload.index);
    let mut buf = Vec::with_capacity(
        A00M_PAYLOAD_HEADER_LEN_V51 + index_bytes.len() + payload.ciphertext_region.len(),
    );
    write_v51_header_bytes(&mut buf, payload);
    buf.extend_from_slice(&index_bytes);
    buf.extend_from_slice(&payload.ciphertext_region);
    buf
}

/// Write the 54-byte v0x51 header to `buf`. Shared by [`serialize_payload_v51`]
/// and [`build_v51_header`] to ensure byte-for-byte consistency (the header
/// participates in per-block AAD, so any divergence breaks decryption).
fn write_v51_header_bytes(buf: &mut Vec<u8>, payload: &V51Payload) {
    buf.extend_from_slice(&A00M_PAYLOAD_MAGIC); // [0..4]
    buf.push(chunked_crypto::A00M_PAYLOAD_VERSION_V51); // [4]
    buf.push(payload.password_version); // [5]
    buf.extend_from_slice(&payload.author_member_id.to_le_bytes()); // [6..14]
    buf.extend_from_slice(&payload.share_id); // [14..30]
    buf.extend_from_slice(&payload.created_at_unix.to_le_bytes()); // [30..38]
    buf.extend_from_slice(&payload.chunk_size.to_le_bytes()); // [38..42]
    buf.extend_from_slice(&payload.block_count.to_le_bytes()); // [42..46]
    buf.extend_from_slice(&payload.real_block_count.to_le_bytes()); // [46..50]
    buf.extend_from_slice(&payload.decoy_ratio_permil.to_le_bytes()); // [50..52]
    buf.extend_from_slice(&[0u8, 0u8]); // [52..54] reserved
}

/// Reconstruct the 54-byte v0x51 header from a [`V51Payload`]. Used by
/// decrypt paths to recompute the per-block AAD.
fn build_v51_header(payload: &V51Payload) -> [u8; 54] {
    let mut buf = Vec::with_capacity(A00M_PAYLOAD_HEADER_LEN_V51);
    write_v51_header_bytes(&mut buf, payload);
    let mut out = [0u8; 54];
    out.copy_from_slice(&buf);
    out
}

/// Deserialize an [`A00MPayload`] from bytes (the APPLICATION block data
/// after the 4-byte `application_id`).
///
/// Returns `Ok(None)` if the bytes don't start with the A00M magic
/// (i.e. this is some other APPLICATION block, not ours).
fn deserialize_payload(bytes: &[u8]) -> Result<Option<A00MPayload>> {
    if bytes.len() < 5 {
        return Ok(None);
    }
    if bytes[0..4] != A00M_PAYLOAD_MAGIC {
        return Ok(None);
    }
    match bytes[4] {
        A00M_PAYLOAD_VERSION => Ok(Some(deserialize_payload_v50(bytes)?)),
        chunked_crypto::A00M_PAYLOAD_VERSION_V51 => Ok(Some(deserialize_payload_v51(bytes)?)),
        other => bail!(
            "unsupported A00MPayload version: 0x{:02x} (expected 0x{:02x} or 0x{:02x})",
            other,
            A00M_PAYLOAD_VERSION,
            chunked_crypto::A00M_PAYLOAD_VERSION_V51
        ),
    }
}

/// Deserialize a v0x50 payload (header + encrypted_zip).
fn deserialize_payload_v50(bytes: &[u8]) -> Result<A00MPayload> {
    if bytes.len() < A00M_PAYLOAD_HEADER_LEN {
        bail!(
            "truncated A00MPayload v0x50: need {} header bytes but only {} available",
            A00M_PAYLOAD_HEADER_LEN,
            bytes.len()
        );
    }
    let password_version = bytes[5];
    let author_member_id = i64::from_le_bytes(bytes[6..14].try_into().expect("7..14 is 8 bytes"));
    let share_id = bytes[14..30].try_into().expect("14..30 is 16 bytes");
    let created_at_unix = i64::from_le_bytes(bytes[30..38].try_into().expect("30..38 is 8 bytes"));
    let zip_len = u32::from_le_bytes(bytes[38..42].try_into().expect("38..42 is 4 bytes")) as usize;
    if bytes.len() < A00M_PAYLOAD_HEADER_LEN + zip_len {
        bail!(
            "truncated A00MPayload v0x50: header claims {} zip bytes but only {} available",
            zip_len,
            bytes.len() - A00M_PAYLOAD_HEADER_LEN
        );
    }
    let encrypted_zip = bytes[A00M_PAYLOAD_HEADER_LEN..A00M_PAYLOAD_HEADER_LEN + zip_len].to_vec();
    Ok(A00MPayload::V50(V50Payload {
        password_version,
        author_member_id,
        share_id,
        created_at_unix,
        encrypted_zip,
    }))
}

/// Deserialize a v0x51 payload (header + index_table + ciphertext_region).
fn deserialize_payload_v51(bytes: &[u8]) -> Result<A00MPayload> {
    if bytes.len() < A00M_PAYLOAD_HEADER_LEN_V51 {
        bail!(
            "truncated A00MPayload v0x51: need {} header bytes but only {} available",
            A00M_PAYLOAD_HEADER_LEN_V51,
            bytes.len()
        );
    }
    let password_version = bytes[5];
    let author_member_id = i64::from_le_bytes(bytes[6..14].try_into().expect("6..14 is 8 bytes"));
    let share_id = bytes[14..30].try_into().expect("14..30 is 16 bytes");
    let created_at_unix = i64::from_le_bytes(bytes[30..38].try_into().expect("30..38 is 8 bytes"));
    let chunk_size = u32::from_le_bytes(bytes[38..42].try_into().expect("38..42 is 4 bytes"));
    let block_count = u32::from_le_bytes(bytes[42..46].try_into().expect("42..46 is 4 bytes"));
    let real_block_count = u32::from_le_bytes(bytes[46..50].try_into().expect("46..50 is 4 bytes"));
    let decoy_ratio_permil =
        u16::from_le_bytes(bytes[50..52].try_into().expect("50..52 is 2 bytes"));
    // bytes[52..54] = reserved (ignored)

    // Index table starts at offset 54, length = block_count * BLOCK_INDEX_ENTRY_LEN.
    let index_len = (block_count as usize)
        .checked_mul(chunked_crypto::BLOCK_INDEX_ENTRY_LEN)
        .ok_or_else(|| anyhow::anyhow!("block_count {} overflows index table size", block_count))?;
    let index_end = A00M_PAYLOAD_HEADER_LEN_V51
        .checked_add(index_len)
        .ok_or_else(|| anyhow::anyhow!("index table end offset overflow"))?;
    if bytes.len() < index_end {
        bail!(
            "truncated A00MPayload v0x51: need {} bytes (header + index) but only {} available",
            index_end,
            bytes.len()
        );
    }
    let index_bytes = &bytes[A00M_PAYLOAD_HEADER_LEN_V51..index_end];
    let index = chunked_crypto::deserialize_index(
        index_bytes,
        chunk_size,
        block_count,
        real_block_count,
        decoy_ratio_permil,
    )?;

    // Sanity check: deserialized index fields should match the header.
    if index.block_count != block_count {
        bail!(
            "v0x51 index block_count mismatch: header={} index={}",
            block_count,
            index.block_count
        );
    }
    if index.real_block_count != real_block_count {
        bail!(
            "v0x51 index real_block_count mismatch: header={} index={}",
            real_block_count,
            index.real_block_count
        );
    }
    if index.chunk_size != chunk_size {
        bail!(
            "v0x51 index chunk_size mismatch: header={} index={}",
            chunk_size,
            index.chunk_size
        );
    }

    // Remaining bytes = ciphertext_region.
    let ciphertext_region = bytes[index_end..].to_vec();

    Ok(A00MPayload::V51(V51Payload {
        password_version,
        author_member_id,
        share_id,
        created_at_unix,
        chunk_size,
        block_count,
        real_block_count,
        decoy_ratio_permil,
        index,
        ciphertext_region,
    }))
}

// ----------------------------------------------------------------------------
// FLAC metadata block manipulation
// ----------------------------------------------------------------------------

/// Parsed FLAC metadata block header (4 bytes).
#[derive(Debug, Clone, Copy)]
struct FlacMetadataBlockHeader {
    /// True if this is the last metadata block before audio frames.
    is_last: bool,
    /// Block type (0=STREAMINFO, 1=PADDING, 2=APPLICATION, 3=SEEKTABLE, ...).
    block_type: u8,
    /// Length of the block's data (excluding the 4-byte header).
    length: u32,
}

impl FlacMetadataBlockHeader {
    fn parse(bytes: &[u8], offset: usize) -> Result<Self> {
        if offset + 4 > bytes.len() {
            bail!("truncated FLAC metadata block header at offset {}", offset);
        }
        let header_byte = bytes[offset];
        let is_last = (header_byte & 0x80) != 0;
        let block_type = header_byte & 0x7f;
        let length = ((bytes[offset + 1] as u32) << 16)
            | ((bytes[offset + 2] as u32) << 8)
            | (bytes[offset + 3] as u32);
        Ok(Self {
            is_last,
            block_type,
            length,
        })
    }
}

/// Find the byte offset where audio frames begin (i.e. the byte right after
/// the last metadata block).
///
/// Also returns the offset of the last metadata block's header (so callers
/// can clear its `is_last` bit when inserting a new block after it).
fn find_audio_frame_offset(flac_bytes: &[u8]) -> Result<(usize, usize)> {
    if flac_bytes.len() < 4 || flac_bytes[0..4] != FLAC_MAGIC {
        bail!("not a FLAC stream: missing 'fLaC' magic");
    }
    let mut offset = 4; // skip "fLaC"
    let mut last_block_header_offset;
    loop {
        let header = FlacMetadataBlockHeader::parse(flac_bytes, offset)?;
        last_block_header_offset = offset;
        offset += 4 + header.length as usize;
        if offset > flac_bytes.len() {
            bail!(
                "FLAC metadata block at offset {} claims length {} but stream is only {} bytes",
                last_block_header_offset,
                header.length,
                flac_bytes.len()
            );
        }
        if header.is_last {
            break;
        }
    }
    Ok((offset, last_block_header_offset))
}

/// Insert an APPLICATION block with `application_id` + `app_data` into a
/// FLAC stream as the **last** metadata block (clearing `is_last` on the
/// previously-last block).
///
/// Returns a new `Vec<u8>` containing the modified FLAC stream.
fn insert_application_block(
    flac_bytes: &[u8],
    app_id: [u8; 4],
    app_data: &[u8],
) -> Result<Vec<u8>> {
    let (audio_offset, last_block_offset) = find_audio_frame_offset(flac_bytes)?;

    // APPLICATION block data = 4-byte app_id + app_data.
    // Block length = data length (app_id + app_data).
    let block_data_len = 4u32
        .checked_add(u32::try_from(app_data.len()).context("app_data too large for FLAC block")?)
        .context("app_data length overflow")?;

    let mut out = Vec::with_capacity(flac_bytes.len() + 4 + 4 + app_data.len());
    // Copy everything up to and including existing metadata blocks.
    out.extend_from_slice(&flac_bytes[..audio_offset]);
    // Clear `is_last` bit on the previously-last metadata block.
    out[last_block_offset] &= 0x7f;
    // Append our APPLICATION block header (is_last=1, type=2, length).
    out.push(0x80 | FLAC_BLOCK_TYPE_APPLICATION);
    out.push((block_data_len >> 16) as u8);
    out.push((block_data_len >> 8) as u8);
    out.push(block_data_len as u8);
    // Append APPLICATION block data.
    out.extend_from_slice(&app_id);
    out.extend_from_slice(app_data);
    // Append audio frames (unchanged).
    out.extend_from_slice(&flac_bytes[audio_offset..]);
    Ok(out)
}

/// Find and extract the A00X APPLICATION block data (the bytes AFTER the
/// 4-byte `application_id`), if present.
fn find_a00x_application_data(flac_bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    if flac_bytes.len() < 4 || flac_bytes[0..4] != FLAC_MAGIC {
        bail!("not a FLAC stream: missing 'fLaC' magic");
    }
    let mut offset = 4; // skip "fLaC"
    while offset + 4 <= flac_bytes.len() {
        let header = FlacMetadataBlockHeader::parse(flac_bytes, offset)?;
        let data_start = offset + 4;
        let data_end = data_start + header.length as usize;
        if data_end > flac_bytes.len() {
            bail!(
                "FLAC APPLICATION block at offset {} truncated: claims {} data bytes but stream is only {} bytes",
                offset,
                header.length,
                flac_bytes.len()
            );
        }
        if header.block_type == FLAC_BLOCK_TYPE_APPLICATION && header.length >= 4 {
            let app_id = &flac_bytes[data_start..data_start + 4];
            if app_id == A00X_APPLICATION_ID {
                // Return bytes AFTER the application_id.
                return Ok(Some(flac_bytes[data_start + 4..data_end].to_vec()));
            }
        }
        offset = data_end;
        if header.is_last {
            break;
        }
    }
    Ok(None)
}

/// Find the absolute byte offset of the `share_id` field within the FLAC
/// stream (for in-place backfill via [`fill_share_id_in_place`]).
///
/// Returns `None` if no A00X APPLICATION block is present.
fn find_share_id_offset(flac_bytes: &[u8]) -> Result<Option<usize>> {
    if flac_bytes.len() < 4 || flac_bytes[0..4] != FLAC_MAGIC {
        bail!("not a FLAC stream: missing 'fLaC' magic");
    }
    let mut offset = 4;
    while offset + 4 <= flac_bytes.len() {
        let header = FlacMetadataBlockHeader::parse(flac_bytes, offset)?;
        let data_start = offset + 4;
        let data_end = data_start + header.length as usize;
        if data_end > flac_bytes.len() {
            bail!("FLAC metadata block at offset {} truncated", offset);
        }
        if header.block_type == FLAC_BLOCK_TYPE_APPLICATION && header.length >= 4 {
            let app_id = &flac_bytes[data_start..data_start + 4];
            if app_id == A00X_APPLICATION_ID {
                // share_id is at payload offset 14 (after magic[4] + version[1]
                // + password_version[1] + author_member_id[8]).
                // Payload starts at data_start + 4 (after application_id).
                let share_id_offset = data_start + 4 + 14;
                if share_id_offset + 16 > data_end {
                    bail!("A00X APPLICATION block too short to contain share_id");
                }
                return Ok(Some(share_id_offset));
            }
        }
        offset = data_end;
        if header.is_last {
            break;
        }
    }
    Ok(None)
}

// ----------------------------------------------------------------------------
// PCM → FLAC encoding (internal helper)
// ----------------------------------------------------------------------------

/// Encode interleaved i32 PCM samples into a FLAC byte stream.
///
/// Mirrors the encoding logic in [`crate::package::encode_wav_to_flac`] but
/// operates on in-memory samples instead of reading from a WAV file.
fn encode_pcm_to_flac(
    samples_i32: &[i32],
    channels: usize,
    bits_per_sample: usize,
    sample_rate: usize,
) -> Result<Vec<u8>> {
    use flacenc::bitsink::ByteSink;
    use flacenc::component::BitRepr;
    use flacenc::config::Encoder;
    use flacenc::error::Verify;
    use flacenc::source::MemSource;

    if samples_i32.is_empty() {
        bail!("cannot encode empty PCM samples");
    }
    if !samples_i32.len().is_multiple_of(channels) {
        bail!(
            "sample count {} is not a multiple of channel count {}",
            samples_i32.len(),
            channels
        );
    }
    let source = MemSource::from_samples(samples_i32, channels, bits_per_sample, sample_rate);
    let config = Encoder::default()
        .into_verified()
        .map_err(|e| anyhow::anyhow!("flacenc config verification failed: {e:?}"))?;
    let block_size = config.block_size;
    let flac_stream = flacenc::encode_with_fixed_block_size(&config, source, block_size)
        .map_err(|e| anyhow::anyhow!("flacenc encode failed: {e:?}"))?;
    let mut sink = ByteSink::new();
    flac_stream
        .write(&mut sink)
        .map_err(|e| anyhow::anyhow!("flacenc bit write failed: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

// ----------------------------------------------------------------------------
// ZIP encryption / decryption
// ----------------------------------------------------------------------------

/// Encrypt `data` as an AES-256 ZIP containing a single entry named
/// `rest.flac`.
///
/// The password is supplied by the caller (from [`crate::passwords`]).
/// Returns the encrypted ZIP as a byte vector.
fn encrypt_rest_as_zip(data: &[u8], password: &[u8]) -> Result<Vec<u8>> {
    let password_str = std::str::from_utf8(password)
        .context("password must be valid UTF-8 for zip::with_aes_encryption")?;

    let mut buf: Vec<u8> = Vec::with_capacity(data.len() + 256);
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = ZipWriter::new(cursor);
        // FLAC is already compressed → use Stored to avoid double-compression
        // overhead. AES-256 provides confidentiality.
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .with_aes_encryption(AesMode::Aes256, password_str);
        zip.start_file(REST_FLAC_ENTRY_NAME, options)
            .context("failed to start rest.flac entry in ZIP")?;
        zip.write_all(data)
            .context("failed to write rest.flac data to ZIP")?;
        zip.finish().context("failed to finalize encrypted ZIP")?;
    }
    Ok(buf)
}

/// Decrypt an AES-256 ZIP (containing `rest.flac`) and return the entry
/// bytes.
///
/// Returns an error if the password is wrong or the ZIP is malformed.
fn decrypt_rest_from_zip(zip_bytes: &[u8], password: &[u8]) -> Result<Vec<u8>> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).context("failed to read encrypted ZIP")?;
    let entry_count = archive.len();
    let mut entry = archive
        .by_name_decrypt(REST_FLAC_ENTRY_NAME, password)
        .with_context(|| {
            format!("rest.flac entry not found in encrypted ZIP (entries: {entry_count})")
        })?;
    let mut out = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut out)
        .context("failed to read rest.flac from encrypted ZIP")?;
    Ok(out)
}

// ----------------------------------------------------------------------------
// Public API: pack / unpack / inspect
// ----------------------------------------------------------------------------

/// Package a song as a shareable FLAC preview file.
///
/// Splits `full_samples` into:
/// - **visible** = `preview_samples` (first `preview_duration_secs` seconds)
///   + `trailer_samples` (a short "trial ended" prompt) — encoded as the
///     audible FLAC stream that any standard player can decode.
/// - **rest** = the remaining samples after the preview — encoded as a
///   separate FLAC stream, encrypted with `password` (AES-256 ZIP), and
///   embedded in an `APPLICATION` block with `application_id = "A00X"`.
///
/// # Arguments
///
/// * `full_samples` - Interleaved i32 PCM samples of the full song.
/// * `sample_rate` - Sample rate in Hz (e.g. 48000).
/// * `channels` - Number of channels (1 = mono, 2 = stereo).
/// * `bits_per_sample` - Bits per sample (typically 16).
/// * `trailer_samples` - PCM of the trailer prompt (same channel count).
/// * `preview_duration_secs` - Length of the preview in seconds (60.0 typical).
/// * `password` - AES-256 ZIP password (from [`crate::passwords`]).
/// * `password_version` - Version number for `password` (recorded in payload).
/// * `author_member_id` - Member ID of the author (copyright record).
/// * `share_id` - Share ID assigned by the server, or all-zeros if not yet
///   registered. Use `[0u8; 16]` when packaging client-side; the server
///   will backfill it via [`fill_share_id_in_place`].
/// * `created_at_unix` - Packaging timestamp (Unix seconds).
///
/// # Returns
///
/// Complete FLAC byte stream including the embedded APPLICATION block.
#[allow(clippy::too_many_arguments)]
pub fn write_flac_preview_container(
    full_samples: &[i32],
    sample_rate: usize,
    channels: usize,
    bits_per_sample: usize,
    trailer_samples: &[i32],
    preview_duration_secs: f32,
    password: &[u8],
    password_version: u8,
    author_member_id: i64,
    share_id: [u8; 16],
    created_at_unix: i64,
) -> Result<Vec<u8>> {
    if full_samples.is_empty() {
        bail!("full_samples is empty");
    }
    if channels == 0 {
        bail!("channels must be > 0");
    }
    if !full_samples.len().is_multiple_of(channels) {
        bail!(
            "full_samples length {} is not a multiple of channels {}",
            full_samples.len(),
            channels
        );
    }
    if !trailer_samples.len().is_multiple_of(channels) {
        bail!(
            "trailer_samples length {} is not a multiple of channels {}",
            trailer_samples.len(),
            channels
        );
    }
    if preview_duration_secs <= 0.0 {
        bail!("preview_duration_secs must be > 0");
    }

    // 1. Split full_samples into preview + rest at a frame boundary.
    let preview_frames = (preview_duration_secs * sample_rate as f32) as usize;
    let total_frames = full_samples.len() / channels;
    if preview_frames >= total_frames {
        bail!(
            "preview_duration_secs {} exceeds total duration {}s — nothing to hide",
            preview_duration_secs,
            total_frames as f32 / sample_rate as f32
        );
    }
    let preview_end = preview_frames * channels;
    let preview_samples = &full_samples[..preview_end];
    let rest_samples = &full_samples[preview_end..];

    // 2. Build visible_samples = preview_samples + trailer_samples.
    let mut visible_samples = Vec::with_capacity(preview_samples.len() + trailer_samples.len());
    visible_samples.extend_from_slice(preview_samples);
    visible_samples.extend_from_slice(trailer_samples);

    // 3. Encode visible FLAC stream.
    let visible_flac = encode_pcm_to_flac(&visible_samples, channels, bits_per_sample, sample_rate)
        .context("failed to encode visible FLAC stream")?;

    // 4. Encode rest FLAC stream.
    let rest_flac = encode_pcm_to_flac(rest_samples, channels, bits_per_sample, sample_rate)
        .context("failed to encode rest FLAC stream")?;

    // 5. Encrypt rest FLAC as AES-256 ZIP.
    let encrypted_zip = encrypt_rest_as_zip(&rest_flac, password)
        .context("failed to encrypt rest FLAC as AES-256 ZIP")?;

    // 6. Build A00MPayload (v0x50).
    let payload = A00MPayload::V50(V50Payload {
        password_version,
        author_member_id,
        share_id,
        created_at_unix,
        encrypted_zip,
    });
    let payload_bytes = serialize_payload(&payload);

    // 7. Insert APPLICATION block into visible FLAC stream.
    let final_flac = insert_application_block(&visible_flac, A00X_APPLICATION_ID, &payload_bytes)
        .context("failed to insert A00X APPLICATION block")?;

    Ok(final_flac)
}

/// Package a song as a shareable FLAC preview file using v5.1 chunked encryption.
///
/// Same as [`write_flac_preview_container`] but uses the v0x51 payload format
/// (chunked AEAD + decoy blocks + algorithm rotation) instead of v0x50
/// AES-256 ZIP. See [`crate::chunked_crypto`] for the security model.
///
/// # Arguments
///
/// Same as [`write_flac_preview_container`], plus:
/// * `decoy_ratio_permil` - Decoy block ratio in per-mille (100 = 10%).
///   Use [`chunked_crypto::DEFAULT_DECOY_RATIO_PERMIL`] for the default.
///
/// # Returns
///
/// Complete FLAC byte stream including the embedded APPLICATION block (v0x51).
#[allow(clippy::too_many_arguments)]
pub fn write_flac_preview_container_chunked(
    full_samples: &[i32],
    sample_rate: usize,
    channels: usize,
    bits_per_sample: usize,
    trailer_samples: &[i32],
    preview_duration_secs: f32,
    password: &[u8],
    password_version: u8,
    author_member_id: i64,
    share_id: [u8; 16],
    created_at_unix: i64,
    decoy_ratio_permil: u16,
) -> Result<Vec<u8>> {
    if full_samples.is_empty() {
        bail!("full_samples is empty");
    }
    if channels == 0 {
        bail!("channels must be > 0");
    }
    if !full_samples.len().is_multiple_of(channels) {
        bail!(
            "full_samples length {} is not a multiple of channels {}",
            full_samples.len(),
            channels
        );
    }
    if !trailer_samples.len().is_multiple_of(channels) {
        bail!(
            "trailer_samples length {} is not a multiple of channels {}",
            trailer_samples.len(),
            channels
        );
    }
    if preview_duration_secs <= 0.0 {
        bail!("preview_duration_secs must be > 0");
    }

    // 1. Split full_samples into preview + rest at a frame boundary.
    let preview_frames = (preview_duration_secs * sample_rate as f32) as usize;
    let total_frames = full_samples.len() / channels;
    if preview_frames >= total_frames {
        bail!(
            "preview_duration_secs {} exceeds total duration {}s — nothing to hide",
            preview_duration_secs,
            total_frames as f32 / sample_rate as f32
        );
    }
    let preview_end = preview_frames * channels;
    let preview_samples = &full_samples[..preview_end];
    let rest_samples = &full_samples[preview_end..];

    // 2. Build visible_samples = preview_samples + trailer_samples.
    let mut visible_samples = Vec::with_capacity(preview_samples.len() + trailer_samples.len());
    visible_samples.extend_from_slice(preview_samples);
    visible_samples.extend_from_slice(trailer_samples);

    // 3. Encode visible FLAC stream.
    let visible_flac = encode_pcm_to_flac(&visible_samples, channels, bits_per_sample, sample_rate)
        .context("failed to encode visible FLAC stream")?;

    // 4. Encode rest FLAC stream.
    let rest_flac = encode_pcm_to_flac(rest_samples, channels, bits_per_sample, sample_rate)
        .context("failed to encode rest FLAC stream")?;

    // 5. Compute block counts for the header (must be populated before
    //    encrypt_rest_chunked because the header participates in per-block AAD).
    let chunk_size_u32 = chunked_crypto::CHUNK_SIZE as u32;
    let real_block_count: u32 = if rest_flac.is_empty() {
        0
    } else {
        u32::try_from(rest_flac.len().div_ceil(chunked_crypto::CHUNK_SIZE))
            .map_err(|e| anyhow::anyhow!("rest_flac too large for u32 block count: {e}"))?
    };
    let decoy_count = chunked_crypto::compute_decoy_count(real_block_count, decoy_ratio_permil);
    let block_count = real_block_count
        .checked_add(decoy_count)
        .ok_or_else(|| anyhow::anyhow!("block_count overflow (real + decoy)"))?;

    // 6. Build V51Payload (share_id may be all-zero at pack time; server backfills later).
    let v51_payload = V51Payload {
        password_version,
        author_member_id,
        share_id,
        created_at_unix,
        chunk_size: chunk_size_u32,
        block_count,
        real_block_count,
        decoy_ratio_permil,
        index: chunked_crypto::ChunkIndex {
            chunk_size: chunk_size_u32,
            block_count,
            real_block_count,
            decoy_ratio_permil,
            entries: Vec::new(), // placeholder; encrypt_rest_chunked will produce the real index
        },
        ciphertext_region: Vec::new(), // placeholder
    };

    // 7. Build the 54-byte header (used for AAD computation during encryption).
    let header = build_v51_header(&v51_payload);

    // 8. Encrypt rest FLAC as chunked AEAD. This produces the real index + ciphertext.
    let (index, ciphertext_region) = chunked_crypto::encrypt_rest_chunked(
        &rest_flac,
        password,
        password_version,
        author_member_id,
        created_at_unix,
        decoy_ratio_permil,
        &header,
    )
    .context("failed to encrypt rest FLAC as v0x51 chunked AEAD")?;

    // 9. Assemble the final V51Payload with the real index + ciphertext.
    let final_payload = A00MPayload::V51(V51Payload {
        password_version,
        author_member_id,
        share_id,
        created_at_unix,
        chunk_size: chunk_size_u32,
        block_count,
        real_block_count,
        decoy_ratio_permil,
        index,
        ciphertext_region,
    });
    let payload_bytes = serialize_payload(&final_payload);

    // 10. Insert APPLICATION block into visible FLAC stream.
    let final_flac = insert_application_block(&visible_flac, A00X_APPLICATION_ID, &payload_bytes)
        .context("failed to insert A00X APPLICATION block")?;

    Ok(final_flac)
}

/// Decrypt the "rest" portion of a shareable FLAC file.
///
/// Reads the A00X APPLICATION block, deserializes the A00MPayload, dispatches
/// to the version-appropriate decryptor (v0x50 ZIP or v0x51 chunked AEAD), and
/// returns `(rest_flac_bytes, copyright_info)`.
///
/// # Errors
///
/// Returns an error if:
/// - The file is not a FLAC stream.
/// - No A00X APPLICATION block is present (not a shareable preview file).
/// - The A00MPayload version is unsupported.
/// - The password is wrong (AEAD tag verification fails).
/// - The ZIP is malformed (v0x50 only).
pub fn decrypt_flac_preview_rest(
    flac_bytes: &[u8],
    password: &[u8],
) -> Result<(Vec<u8>, CopyrightInfo)> {
    let payload_bytes = find_a00x_application_data(flac_bytes)?.ok_or_else(|| {
        anyhow::anyhow!("no A00X APPLICATION block found — not a shareable preview file")
    })?;
    let payload = deserialize_payload(&payload_bytes)?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "A00X APPLICATION block exists but payload magic mismatch — corrupted or unknown format"
            )
        })?;
    let copyright = CopyrightInfo::from(&payload);
    let rest_flac = match &payload {
        A00MPayload::V50(v) => decrypt_v50_rest(v, password)?,
        A00MPayload::V51(v) => decrypt_v51_rest(v, password)?,
    };
    Ok((rest_flac, copyright))
}

/// Decrypt the rest FLAC from a v0x50 payload (AES-256 ZIP).
fn decrypt_v50_rest(payload: &V50Payload, password: &[u8]) -> Result<Vec<u8>> {
    decrypt_rest_from_zip(&payload.encrypted_zip, password)
        .context("failed to decrypt rest.flac — wrong password or corrupted encrypted ZIP")
}

/// Decrypt the rest FLAC from a v0x51 payload (chunked AEAD).
///
/// Reconstructs the 54-byte header from the payload fields (the header
/// participates in per-block AAD) and calls [`chunked_crypto::decrypt_all_blocks`].
fn decrypt_v51_rest(payload: &V51Payload, password: &[u8]) -> Result<Vec<u8>> {
    let header = build_v51_header(payload);
    chunked_crypto::decrypt_all_blocks(
        &payload.ciphertext_region,
        &payload.index,
        password,
        payload.author_member_id,
        payload.created_at_unix,
        payload.password_version,
        &header,
    )
    .context("failed to decrypt v0x51 chunked rest — wrong password or tampered ciphertext")
}

/// Check whether a FLAC byte stream contains an A00X APPLICATION block.
///
/// Returns `false` if the input is not a FLAC stream or has no A00X block.
pub fn has_a00x_application_block(flac_bytes: &[u8]) -> bool {
    if flac_bytes.len() < 4 || flac_bytes[0..4] != FLAC_MAGIC {
        return false;
    }
    matches!(find_a00x_application_data(flac_bytes), Ok(Some(_)))
}

/// Read copyright info from a shareable FLAC file without decrypting the
/// embedded rest portion.
///
/// Returns `Ok(None)` if no A00X APPLICATION block is present (i.e. this is
/// a regular FLAC file, not a shareable preview).
pub fn read_copyright_info(flac_bytes: &[u8]) -> Result<Option<CopyrightInfo>> {
    let Some(payload_bytes) = find_a00x_application_data(flac_bytes)? else {
        return Ok(None);
    };
    let Some(payload) = deserialize_payload(&payload_bytes)? else {
        return Ok(None);
    };
    Ok(Some(CopyrightInfo::from(&payload)))
}

/// Read the `password_version` field from a shareable FLAC file.
///
/// Returns `Ok(None)` if no A00X APPLICATION block is present. The player
/// uses this to look up the correct password in [`crate::passwords`].
pub fn read_password_version(flac_bytes: &[u8]) -> Result<Option<u8>> {
    let Some(payload_bytes) = find_a00x_application_data(flac_bytes)? else {
        return Ok(None);
    };
    let Some(payload) = deserialize_payload(&payload_bytes)? else {
        return Ok(None);
    };
    Ok(Some(match &payload {
        A00MPayload::V50(v) => v.password_version,
        A00MPayload::V51(v) => v.password_version,
    }))
}

/// Backfill the `share_id` field in a shareable FLAC file, in place.
///
/// Called by the server after registering a share: the client packs with
/// `share_id = [0; 16]`, uploads to the server, and the server fills in
/// the assigned `share_id` without re-encrypting the payload.
///
/// # Errors
///
/// Returns an error if no A00X APPLICATION block is present or the block
/// is too short to contain the `share_id` field.
pub fn fill_share_id_in_place(flac_bytes: &mut [u8], share_id: [u8; 16]) -> Result<()> {
    let offset = find_share_id_offset(flac_bytes)?.ok_or_else(|| {
        anyhow::anyhow!("no A00X APPLICATION block found — cannot backfill share_id")
    })?;
    flac_bytes[offset..offset + 16].copy_from_slice(&share_id);
    Ok(())
}

/// Compute the SHA-256 content hash of a FLAC byte stream.
///
/// Used for content-addressable storage and tamper detection (e.g. after
/// P2P download, the client verifies `SHA-256(downloaded) == expected_hash`).
pub fn compute_content_hash(flac_bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(flac_bytes);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

// ----------------------------------------------------------------------------
// Public API: v0x51 chunked encryption inspection / streaming
// ----------------------------------------------------------------------------

/// Read the chunk index from a v0x51 shareable FLAC file.
///
/// Returns `Ok(None)` if:
/// - The file has no A00X APPLICATION block.
/// - The file is v0x50 (no chunk index — v0x50 uses whole-file ZIP).
///
/// Use this to plan streaming downloads: the index tells the client which
/// blocks are real vs decoy and their byte offsets in the ciphertext region.
pub fn read_chunk_index(flac_bytes: &[u8]) -> Result<Option<chunked_crypto::ChunkIndex>> {
    let Some(payload_bytes) = find_a00x_application_data(flac_bytes)? else {
        return Ok(None);
    };
    let Some(payload) = deserialize_payload(&payload_bytes)? else {
        return Ok(None);
    };
    match payload {
        A00MPayload::V50(_) => Ok(None),
        A00MPayload::V51(v) => Ok(Some(v.index)),
    }
}

/// Decrypt a contiguous range of real blocks `[block_start..=block_end]` from
/// a v0x51 shareable FLAC file.
///
/// `block_start` and `block_end` are **real-block indices** (0-based, ignoring
/// decoy blocks). `block_end` is inclusive.
///
/// Used for streaming playback: the client downloads only the ciphertext for
/// the requested range (via [`chunked_crypto::block_range_to_byte_range`] to
/// compute the HTTP Range header) and calls this function to decrypt it.
///
/// # Errors
///
/// Returns an error if:
/// - The file has no A00X APPLICATION block.
/// - The file is v0x50 (no chunked encryption — use [`decrypt_flac_preview_rest`] instead).
/// - The block range is empty or out of bounds.
/// - Any block's AEAD tag fails to verify (wrong password or tampered ciphertext).
pub fn decrypt_block_range(
    flac_bytes: &[u8],
    password: &[u8],
    block_start: u32,
    block_end: u32,
) -> Result<Vec<u8>> {
    let payload_bytes = find_a00x_application_data(flac_bytes)?.ok_or_else(|| {
        anyhow::anyhow!("no A00X APPLICATION block found — not a shareable preview file")
    })?;
    let payload = deserialize_payload(&payload_bytes)?.ok_or_else(|| {
        anyhow::anyhow!("A00X APPLICATION block exists but payload magic mismatch")
    })?;
    match payload {
        A00MPayload::V50(_) => {
            bail!("file is v0x50 (ZIP-encrypted) — no block range supported; use decrypt_flac_preview_rest instead")
        }
        A00MPayload::V51(v) => {
            let header = build_v51_header(&v);
            chunked_crypto::decrypt_block_range(
                &v.ciphertext_region,
                &v.index,
                password,
                v.author_member_id,
                v.created_at_unix,
                v.password_version,
                &header,
                block_start,
                block_end,
            )
        }
    }
}

// ----------------------------------------------------------------------------
// Public API: bytes-based inspection / decryption (for block-level Range download)
// ----------------------------------------------------------------------------

/// Read the chunk index from v0x51 APPLICATION block payload bytes.
///
/// Input is the **payload bytes** (the data AFTER the 4-byte `application_id`),
/// NOT the full FLAC stream. Use [`find_a00x_application_data`] to extract the
/// payload bytes from a FLAC stream, or call this directly on bytes obtained
/// via a block-level HTTP Range download of just the APPLICATION block.
///
/// Returns `Ok(None)` if:
/// - The payload magic does not match (not an A00M payload).
/// - The payload is v0x50 (no chunk index — v0x50 uses whole-file ZIP).
///
/// Use this to plan streaming downloads: the index tells the client which
/// blocks are real vs decoy and their byte offsets in the ciphertext region.
pub fn read_chunk_index_from_bytes(
    payload_bytes: &[u8],
) -> Result<Option<chunked_crypto::ChunkIndex>> {
    let Some(payload) = deserialize_payload(payload_bytes)? else {
        return Ok(None);
    };
    match payload {
        A00MPayload::V50(_) => Ok(None),
        A00MPayload::V51(v) => Ok(Some(v.index)),
    }
}

/// Decrypt the rest FLAC from APPLICATION block payload bytes.
///
/// Input is the **payload bytes** (the data AFTER the 4-byte `application_id`),
/// NOT the full FLAC stream. This is the bytes-based counterpart of
/// [`decrypt_flac_preview_rest`] — use it when you have downloaded only the
/// APPLICATION block via a block-level HTTP Range request (avoiding the need
/// to download the entire `.a00m` file).
///
/// Automatically dispatches to the v0x50 (AES-256 ZIP) or v0x51 (chunked AEAD)
/// decryption path based on the payload version byte.
///
/// # Errors
///
/// Returns an error if:
/// - The payload magic does not match (not an A00M payload).
/// - The password is wrong (AEAD tag verification fails).
/// - The ZIP is malformed (v0x50 only).
pub fn decrypt_rest_from_bytes(payload_bytes: &[u8], password: &[u8]) -> Result<Vec<u8>> {
    let payload = deserialize_payload(payload_bytes)?.ok_or_else(|| {
        anyhow::anyhow!(
            "A00X APPLICATION block exists but payload magic mismatch — corrupted or unknown format"
        )
    })?;
    match payload {
        A00MPayload::V50(v) => decrypt_v50_rest(&v, password),
        A00MPayload::V51(v) => decrypt_v51_rest(&v, password),
    }
}

/// Locate the A00X APPLICATION block's byte range within a FLAC stream.
///
/// Returns `Ok(None)` if no A00X APPLICATION block is present. Otherwise
/// returns `(block_start, block_end)` where:
/// - `block_start` is the absolute byte offset of the metadata block header
///   (the 4-byte `type+length` header).
/// - `block_end` is the absolute byte offset one past the last byte of the
///   block's data (i.e. `block_end - block_start` is the total block size
///   including the 4-byte header).
///
/// Used by the downloader to compute HTTP Range requests for just the
/// APPLICATION block (avoiding a full-file download).
///
/// # Errors
///
/// Returns an error if the input is not a FLAC stream or a metadata block is
/// truncated.
pub fn find_a00x_application_block_range(flac_bytes: &[u8]) -> Result<Option<(usize, usize)>> {
    if flac_bytes.len() < 4 || flac_bytes[0..4] != FLAC_MAGIC {
        bail!("not a FLAC stream: missing 'fLaC' magic");
    }
    let mut offset = 4; // skip "fLaC"
    while offset + 4 <= flac_bytes.len() {
        let header = FlacMetadataBlockHeader::parse(flac_bytes, offset)?;
        let data_start = offset + 4;
        let data_end = data_start + header.length as usize;
        if data_end > flac_bytes.len() {
            bail!(
                "FLAC APPLICATION block at offset {} truncated: claims {} data bytes but stream is only {} bytes",
                offset,
                header.length,
                flac_bytes.len()
            );
        }
        if header.block_type == FLAC_BLOCK_TYPE_APPLICATION && header.length >= 4 {
            let app_id = &flac_bytes[data_start..data_start + 4];
            if app_id == A00X_APPLICATION_ID {
                return Ok(Some((offset, data_end)));
            }
        }
        offset = data_end;
        if header.is_last {
            break;
        }
    }
    Ok(None)
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate `duration_secs` of synthetic interleaved PCM (sine wave).
    fn make_sine_samples(duration_secs: f32, sample_rate: usize, channels: usize) -> Vec<i32> {
        let n_frames = (duration_secs * sample_rate as f32) as usize;
        let mut out = Vec::with_capacity(n_frames * channels);
        for frame in 0..n_frames {
            let t = frame as f32 / sample_rate as f32;
            // 440Hz sine, amplitude 0.5
            let sample = (t * 440.0 * 2.0 * std::f32::consts::PI).sin() * 0.5;
            let i32_sample = (sample * 32767.0).round() as i32;
            for _ch in 0..channels {
                out.push(i32_sample);
            }
        }
        out
    }

    fn make_trailer_samples(sample_rate: usize, channels: usize) -> Vec<i32> {
        // 0.5 second of low-amplitude noise as a placeholder "trailer".
        make_sine_samples(0.5, sample_rate, channels)
            .iter()
            .map(|s| s / 4) // quieter
            .collect()
    }

    const TEST_PASSWORD: &[u8] = b"test-password-for-v5-unit-tests-only";

    #[test]
    fn payload_round_trip_serialization() {
        let payload = A00MPayload::V50(V50Payload {
            password_version: 1,
            author_member_id: 42,
            share_id: [0xAB; 16],
            created_at_unix: 1_700_000_000,
            encrypted_zip: vec![0xDE, 0xAD, 0xBE, 0xEF],
        });
        let bytes = serialize_payload(&payload);
        assert_eq!(&bytes[0..4], A00M_PAYLOAD_MAGIC);
        assert_eq!(bytes[4], A00M_PAYLOAD_VERSION);
        let decoded = deserialize_payload(&bytes).unwrap().unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn deserialize_returns_none_for_non_a00m_magic() {
        let bytes = [0u8; 50];
        assert!(deserialize_payload(&bytes).unwrap().is_none());
    }

    #[test]
    fn deserialize_rejects_wrong_version() {
        let mut bytes = serialize_payload(&A00MPayload::V50(V50Payload {
            password_version: 1,
            author_member_id: 0,
            share_id: [0; 16],
            created_at_unix: 0,
            encrypted_zip: vec![],
        }));
        bytes[4] = 0xFF; // unknown version
        assert!(deserialize_payload(&bytes).is_err());
    }

    #[test]
    fn flac_preview_round_trip() {
        let sample_rate = 8000; // low rate for fast tests
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        // 5 seconds total, 1 second preview, 0.5s trailer
        let full_samples = make_sine_samples(5.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0, // 1 second preview
            TEST_PASSWORD,
            1,
            12345,
            [0; 16],
            1_700_000_000,
        )
        .expect("pack failed");

        // 1. Standard FLAC magic present.
        assert_eq!(&flac_bytes[0..4], b"fLaC");

        // 2. A00X APPLICATION block present.
        assert!(has_a00x_application_block(&flac_bytes));

        // 3. Copyright info readable without decryption.
        let copyright = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(copyright.password_version, 1);
        assert_eq!(copyright.author_member_id, 12345);
        assert_eq!(copyright.share_id, [0; 16]);
        assert_eq!(copyright.created_at_unix, 1_700_000_000);

        // 4. password_version readable.
        assert_eq!(read_password_version(&flac_bytes).unwrap(), Some(1));

        // 5. Decrypt rest with correct password succeeds.
        let (rest_flac, copyright2) =
            decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD).expect("decrypt failed");
        assert_eq!(copyright2, copyright);
        assert!(!rest_flac.is_empty());
        assert_eq!(&rest_flac[0..4], b"fLaC"); // rest is a valid FLAC stream

        // 6. Decrypt with wrong password fails.
        let wrong = decrypt_flac_preview_rest(&flac_bytes, b"wrong-password");
        assert!(wrong.is_err(), "wrong password should fail decryption");
    }

    #[test]
    fn fill_share_id_in_place_works() {
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(3.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let mut flac_bytes = write_flac_preview_container(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            999,
            [0; 16],
            1_700_000_000,
        )
        .unwrap();

        // share_id should initially be all zeros.
        let before = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(before.share_id, [0; 16]);

        // Backfill a share_id.
        let new_share_id: [u8; 16] = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60,
            0x70, 0x80,
        ];
        fill_share_id_in_place(&mut flac_bytes, new_share_id).unwrap();

        // Verify share_id is now set.
        let after = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(after.share_id, new_share_id);

        // Other fields unchanged.
        assert_eq!(after.author_member_id, 999);
        assert_eq!(after.password_version, 1);

        // Decryption still works after backfill (encryption key unchanged).
        let (rest_flac, _) = decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD)
            .expect("decrypt after fill_share_id should work");
        assert!(!rest_flac.is_empty());
    }

    #[test]
    fn has_a00x_returns_false_for_plain_flac() {
        // Encode a plain FLAC (no APPLICATION block).
        let samples = make_sine_samples(1.0, 8000, 1);
        let plain_flac =
            encode_pcm_to_flac(&samples, 1, FLAC_BITS_PER_SAMPLE as usize, 8000).unwrap();
        assert!(!has_a00x_application_block(&plain_flac));
        assert!(read_copyright_info(&plain_flac).unwrap().is_none());
        assert!(read_password_version(&plain_flac).unwrap().is_none());
    }

    #[test]
    fn has_a00x_returns_false_for_non_flac() {
        assert!(!has_a00x_application_block(b"not a flac file"));
        assert!(!has_a00x_application_block(&[]));
    }

    #[test]
    fn compute_content_hash_is_deterministic() {
        let samples = make_sine_samples(1.0, 8000, 1);
        let flac = encode_pcm_to_flac(&samples, 1, FLAC_BITS_PER_SAMPLE as usize, 8000).unwrap();
        let h1 = compute_content_hash(&flac);
        let h2 = compute_content_hash(&flac);
        assert_eq!(h1, h2);

        // Different content → different hash.
        let samples2 = make_sine_samples(2.0, 8000, 1);
        let flac2 = encode_pcm_to_flac(&samples2, 1, FLAC_BITS_PER_SAMPLE as usize, 8000).unwrap();
        let h3 = compute_content_hash(&flac2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn preview_too_long_fails() {
        let samples = make_sine_samples(2.0, 8000, 1);
        let trailer = make_trailer_samples(8000, 1);
        // Preview duration > total duration should fail.
        let result = write_flac_preview_container(
            &samples,
            8000,
            1,
            FLAC_BITS_PER_SAMPLE as usize,
            &trailer,
            5.0, // > 2.0s total
            TEST_PASSWORD,
            1,
            1,
            [0; 16],
            0,
        );
        assert!(result.is_err());
    }

    #[test]
    fn find_audio_frame_offset_on_plain_flac() {
        let samples = make_sine_samples(0.5, 8000, 1);
        let flac = encode_pcm_to_flac(&samples, 1, FLAC_BITS_PER_SAMPLE as usize, 8000).unwrap();
        let (audio_offset, last_block_offset) =
            find_audio_frame_offset(&flac).expect("parse failed");
        assert!(audio_offset > 4); // past "fLaC" + STREAMINFO
        assert!(last_block_offset >= 4); // at least past "fLaC"
        assert!(audio_offset < flac.len()); // audio frames exist
    }

    // ------------------------------------------------------------------------
    // v0x51 chunked encryption tests
    // ------------------------------------------------------------------------

    /// Generate pseudo-random noise samples (incompressible) for tests that
    /// need large rest FLAC output to span multiple blocks.
    fn make_noise_samples(duration_secs: f32, sample_rate: usize, channels: usize) -> Vec<i32> {
        let n_frames = (duration_secs * sample_rate as f32) as usize;
        let mut out = Vec::with_capacity(n_frames * channels);
        // Simple LCG random — deterministic across runs for reproducible tests.
        let mut state: u32 = 0x1234_5678;
        for _ in 0..n_frames {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let sample = ((state >> 16) as i32) - 32768; // range ~[-32768, 32767]
            for _ in 0..channels {
                out.push(sample);
            }
        }
        out
    }

    #[test]
    fn v51_round_trip() {
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        // 5 seconds total, 1 second preview, 0.5s trailer
        let full_samples = make_sine_samples(5.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0, // 1 second preview
            TEST_PASSWORD,
            1,             // password_version
            12345,         // author_member_id
            [0; 16],       // share_id (zero = not yet registered)
            1_700_000_000, // created_at_unix
            chunked_crypto::DEFAULT_DECOY_RATIO_PERMIL,
        )
        .expect("v0x51 pack failed");

        // 1. Standard FLAC magic present.
        assert_eq!(&flac_bytes[0..4], b"fLaC");

        // 2. A00X APPLICATION block present.
        assert!(has_a00x_application_block(&flac_bytes));

        // 3. Copyright info readable without decryption.
        let copyright = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(copyright.password_version, 1);
        assert_eq!(copyright.author_member_id, 12345);
        assert_eq!(copyright.share_id, [0; 16]);
        assert_eq!(copyright.created_at_unix, 1_700_000_000);

        // 4. password_version readable.
        assert_eq!(read_password_version(&flac_bytes).unwrap(), Some(1));

        // 5. Decrypt rest with correct password succeeds.
        let (rest_flac, copyright2) =
            decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD).expect("v0x51 decrypt failed");
        assert_eq!(copyright2, copyright);
        assert!(!rest_flac.is_empty());
        assert_eq!(&rest_flac[0..4], b"fLaC"); // rest is a valid FLAC stream

        // 6. Decrypt with wrong password fails.
        let wrong = decrypt_flac_preview_rest(&flac_bytes, b"wrong-password");
        assert!(
            wrong.is_err(),
            "wrong password should fail v0x51 decryption"
        );
    }

    #[test]
    fn v51_read_chunk_index_returns_some() {
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(3.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            42,
            [0; 16],
            1_700_000_000,
            0, // ratio=0 → no decoy blocks
        )
        .unwrap();

        let index = read_chunk_index(&flac_bytes)
            .unwrap()
            .expect("index should be Some for v0x51");
        assert_eq!(index.chunk_size, chunked_crypto::CHUNK_SIZE as u32);
        assert!(index.block_count >= 1);
        assert_eq!(index.block_count, index.real_block_count); // no decoys
        assert_eq!(index.decoy_ratio_permil, 0);
        assert_eq!(index.entries.len(), index.block_count as usize);
        // All entries should be real (not decoy) since ratio=0.
        assert!(index.entries.iter().all(|e| !e.is_decoy()));
    }

    #[test]
    fn v51_read_chunk_index_v50_returns_none() {
        // Pack as v0x50 (old format).
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(3.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            42,
            [0; 16],
            1_700_000_000,
        )
        .unwrap();

        // v0x50 files have no chunk index.
        assert!(read_chunk_index(&flac_bytes).unwrap().is_none());
    }

    #[test]
    fn v51_decrypt_block_range_first_3() {
        // Use noise (incompressible) to ensure rest FLAC spans multiple blocks.
        // 44100 Hz stereo 16-bit for 15s = ~2.5 MiB PCM → ~2 MiB FLAC → 8+ blocks.
        let sample_rate = 44100;
        let channels = 2;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_noise_samples(15.0, sample_rate, channels);
        let trailer_samples = make_noise_samples(0.5, sample_rate, channels);

        let flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0, // 1s preview → 5s rest
            TEST_PASSWORD,
            1,
            99,
            [0; 16],
            1_700_000_000,
            0, // ratio=0 for predictable block count
        )
        .unwrap();

        let index = read_chunk_index(&flac_bytes).unwrap().unwrap();
        assert!(
            index.real_block_count >= 3,
            "test needs >=3 real blocks, got {}",
            index.real_block_count
        );

        // Decrypt range [0..=2] (first 3 real blocks).
        let range_bytes = decrypt_block_range(&flac_bytes, TEST_PASSWORD, 0, 2)
            .expect("decrypt_block_range failed");

        // Decrypt full and compare first 3 blocks worth of plaintext.
        let full_rest = decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD)
            .expect("full decrypt failed")
            .0;

        // Each real block is CHUNK_SIZE bytes (except possibly the last).
        let expected_first_3_len = (chunked_crypto::CHUNK_SIZE * 3).min(full_rest.len());
        assert_eq!(range_bytes.len(), expected_first_3_len);
        assert_eq!(&range_bytes[..], &full_rest[..expected_first_3_len]);
    }

    #[test]
    fn v51_decoy_blocks_present() {
        // Use noise (incompressible) to ensure rest FLAC spans multiple blocks
        // (decoy insertion requires real_block_count >= 2).
        let sample_rate = 44100;
        let channels = 2;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_noise_samples(15.0, sample_rate, channels);
        let trailer_samples = make_noise_samples(0.5, sample_rate, channels);

        let flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            1,
            [0; 16],
            1_700_000_000,
            500, // ratio=500 = 50% decoy blocks
        )
        .unwrap();

        let index = read_chunk_index(&flac_bytes).unwrap().unwrap();
        let decoy_count = index.entries.iter().filter(|e| e.is_decoy()).count();
        assert!(
            decoy_count > 0,
            "expected decoy blocks with ratio=500, got 0"
        );
        assert!(index.block_count > index.real_block_count);

        // Full decryption still works despite decoys.
        let (rest_flac, _) = decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD)
            .expect("decrypt with decoys should work");
        assert!(!rest_flac.is_empty());
    }

    #[test]
    fn v51_backward_compat_v50_still_works() {
        // Explicitly verify v0x50 files still decrypt after the enum refactor.
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(5.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            777,
            [0; 16],
            1_700_000_000,
        )
        .expect("v0x50 pack failed");

        // read_chunk_index returns None for v0x50.
        assert!(read_chunk_index(&flac_bytes).unwrap().is_none());

        // decrypt_block_range returns error for v0x50.
        let range_err = decrypt_block_range(&flac_bytes, TEST_PASSWORD, 0, 0);
        assert!(range_err.is_err());

        // decrypt_flac_preview_rest still works for v0x50.
        let (rest_flac, copyright) =
            decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD).expect("v0x50 decrypt failed");
        assert_eq!(copyright.author_member_id, 777);
        assert!(!rest_flac.is_empty());
        assert_eq!(&rest_flac[0..4], b"fLaC");
    }

    #[test]
    fn v51_compute_content_hash_works() {
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(3.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            1,
            [0; 16],
            1_700_000_000,
            0,
        )
        .unwrap();

        let h1 = compute_content_hash(&flac_bytes);
        let h2 = compute_content_hash(&flac_bytes);
        assert_eq!(h1, h2, "content hash should be deterministic");

        // Different content → different hash.
        let full_samples2 = make_sine_samples(4.0, sample_rate, channels);
        let flac_bytes2 = write_flac_preview_container_chunked(
            &full_samples2,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            1,
            [0; 16],
            1_700_000_000,
            0,
        )
        .unwrap();
        let h3 = compute_content_hash(&flac_bytes2);
        assert_ne!(h1, h3, "different content should have different hash");
    }

    // ------------------------------------------------------------------------
    // v0x51 fill_share_id_in_place compatibility tests
    // ------------------------------------------------------------------------

    #[test]
    fn v51_fill_share_id_in_place_works() {
        // Pack as v0x51 with share_id = [0; 16] (not yet registered).
        let sample_rate = 8000;
        let channels = 1;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_sine_samples(5.0, sample_rate, channels);
        let trailer_samples = make_trailer_samples(sample_rate, channels);

        let mut flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            999,
            [0; 16], // share_id = zero (not yet registered)
            1_700_000_000,
            0, // ratio=0 for simplicity
        )
        .unwrap();

        // share_id should initially be all zeros.
        let before = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(before.share_id, [0; 16]);

        // Backfill a share_id (simulating server registration).
        let new_share_id: [u8; 16] = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60,
            0x70, 0x80,
        ];
        fill_share_id_in_place(&mut flac_bytes, new_share_id).unwrap();

        // Verify share_id is now set.
        let after = read_copyright_info(&flac_bytes).unwrap().unwrap();
        assert_eq!(after.share_id, new_share_id);
        assert_eq!(after.author_member_id, 999);

        // Decryption still works after backfill — this is the critical assertion:
        // AAD deliberately skips the share_id field (header[14..30]), so modifying
        // share_id in place does not invalidate any block's AEAD tag.
        let (rest_flac, _) = decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD)
            .expect("decrypt after fill_share_id should work");
        assert!(!rest_flac.is_empty());
        assert_eq!(&rest_flac[0..4], b"fLaC");
    }

    #[test]
    fn v51_fill_share_id_does_not_break_block_decrypt() {
        // Use noise to ensure multiple blocks for block_range testing.
        let sample_rate = 44100;
        let channels = 2;
        let bits_per_sample = FLAC_BITS_PER_SAMPLE as usize;
        let full_samples = make_noise_samples(15.0, sample_rate, channels);
        let trailer_samples = make_noise_samples(0.5, sample_rate, channels);

        let mut flac_bytes = write_flac_preview_container_chunked(
            &full_samples,
            sample_rate,
            channels,
            bits_per_sample,
            &trailer_samples,
            1.0,
            TEST_PASSWORD,
            1,
            42,
            [0; 16],
            1_700_000_000,
            0, // ratio=0
        )
        .unwrap();

        let index = read_chunk_index(&flac_bytes).unwrap().unwrap();
        assert!(index.real_block_count >= 2, "need >=2 real blocks");

        // Backfill share_id.
        let new_share_id: [u8; 16] = [0xAA; 16];
        fill_share_id_in_place(&mut flac_bytes, new_share_id).unwrap();

        // decrypt_block_range still works after share_id backfill — validates
        // that AAD skips the share_id field at the chunked_crypto layer too.
        let last_real = index.real_block_count - 1;
        let range_bytes = decrypt_block_range(&flac_bytes, TEST_PASSWORD, 0, last_real)
            .expect("decrypt_block_range after fill_share_id should work");
        assert!(!range_bytes.is_empty());

        // Compare with full decryption.
        let full_rest = decrypt_flac_preview_rest(&flac_bytes, TEST_PASSWORD)
            .expect("full decrypt should work")
            .0;
        assert_eq!(range_bytes.len(), full_rest.len());
        assert_eq!(&range_bytes[..], &full_rest[..]);
    }
}
