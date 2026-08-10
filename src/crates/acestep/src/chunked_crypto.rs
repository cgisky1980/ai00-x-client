//! `.a00m` v5.1 chunked encryption core.
//!
//! Replaces the v5.0 whole-file AES-256 ZIP encryption with a streaming-friendly
//! format: the plaintext (`rest.flac`) is split into fixed-size blocks, each
//! encrypted independently with an AEAD cipher (AES-256-GCM or ChaCha20-Poly1305,
//! rotated by block index). A block index table at the head of the payload lets
//! clients decrypt any byte range without downloading the whole file.
//!
//! "Hua huo" (花活) features:
//! - **Algorithm rotation**: even blocks use AES-256-GCM, odd blocks use
//!   ChaCha20-Poly1305. Cracking one block does not reveal the next.
//! - **Per-block key derivation**: each block key is derived from the master
//!   password via HKDF-SHA256 with `block_index` + `algo_id` + `is_decoy` in
//!   the `info` field, so even if one key leaks, others remain secure.
//! - **Decoy blocks**: ~10% of blocks are random ciphertext that cannot be
//!   decrypted. Attackers cannot tell real from decoy blocks without the
//!   master password, forcing them to attempt decryption on all blocks.
//!
//! ## Format
//!
//! See [`flac_container`](crate::flac_container) for the outer FLAC + APPLICATION
//! block layout. This module defines the *payload* layout (A00MPayload v0x51):
//!
//! ```text
//! ┌──── Header (54 bytes) ────┐
//! │ magic "A00M" + version 0x51 + password_version
//! │ + author_member_id + share_id + created_at_unix
//! │ + chunk_size + block_count + real_block_count
//! │ + decoy_ratio_permil + reserved
//! └────────────────────────────┘
//! ┌──── Block index table (N × 36 bytes) ────┐
//! │ BlockIndexEntry #0
//! │ BlockIndexEntry #1
//! │ ...
//! │ BlockIndexEntry #(N-1)
//! └──────────────────────────────────────────┘
//! ┌──── Ciphertext region ────┐
//! │ Block #0 ciphertext + 16-byte tag
//! │ Block #1 ciphertext + 16-byte tag
//! │ ...
//! │ Block #(N-1) ciphertext + 16-byte tag
//! └───────────────────────────┘
//! ```
//!
//! ## Security model
//!
//! - **Master password** comes from [`crate::passwords`] (hardcoded multi-version
//!   table, no KDF at the password layer).
//! - **Per-block key** = `HKDF-SHA256(salt, IKM=master_password, info)` where
//!   `salt = SHA-256(author_member_id || created_at_unix || password_version)[0..16]`
//!   and `info` includes `block_index` + `algo_id` + `chunk_size` + `is_decoy`.
//! - **share_id is NOT in the key derivation** — it is filled in by the server
//!   after packaging (see `fill_share_id_in_place`), so it cannot participate.
//! - **AAD** = `header[0..14] || header[30..54] || block_index_le(4) ||
//!   block_aad_hash[0..12]` — skips the `share_id` field (14..30) so it can be
//!   backfilled without invalidating the AAD.
//! - **AEAD tag** (16 bytes per block) detects any tampering with ciphertext,
//!   nonce, or AAD. Block swap attacks fail because `block_index` is in the AAD.

use anyhow::{bail, Result};
use rand::RngCore;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/// Plaintext block size in bytes (256 KiB).
///
/// Chosen to align with WebTorrent's default piece size (Phase E P2P), giving
/// ~1.36 s first-play latency at 48 kHz/16-bit/stereo and ~720 B index overhead
/// for a 5 MB song.
pub const CHUNK_SIZE: usize = 262_144;

/// Length of one block index entry in bytes (see [`BlockIndexEntry`]).
pub const BLOCK_INDEX_ENTRY_LEN: usize = 36;

/// A00MPayload version byte for v5.1 (chunked encryption format).
pub const A00M_PAYLOAD_VERSION_V51: u8 = 0x51; // 'Q' ASCII

/// Algorithm ID: AES-256-GCM (96-bit nonce, 128-bit tag).
pub const ALGO_AES_256_GCM: u8 = 0x01;

/// Algorithm ID: ChaCha20-Poly1305 (96-bit nonce, 128-bit tag).
pub const ALGO_CHACHA20_POLY1305: u8 = 0x02;

/// Default decoy block ratio in per-mille (100 = 10%).
pub const DEFAULT_DECOY_RATIO_PERMIL: u16 = 100;

/// AEAD tag length in bytes (both AES-GCM and ChaCha20-Poly1305 use 128-bit tags).
pub const AEAD_TAG_LEN: usize = 16;

/// Nonce length in bytes (both algorithms use 96-bit nonces).
pub const NONCE_LEN: usize = 12;

/// AES-256 key length in bytes.
pub const KEY_LEN: usize = 32;

/// Flag bit: this block is a decoy (random ciphertext, undecryptable).
pub const FLAG_IS_DECOY: u8 = 0x01;

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/// A single block index entry (36 bytes serialized).
///
/// See module docs for the binary layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockIndexEntry {
    /// Absolute offset of this block's ciphertext (excluding the 16-byte tag)
    /// within the A00MPayload.
    pub offset: u32,
    /// Ciphertext length in bytes (excluding the 16-byte tag).
    pub length: u32,
    /// Algorithm ID (`ALGO_AES_256_GCM` or `ALGO_CHACHA20_POLY1305`).
    pub algo_id: u8,
    /// Key ID (= `password_version`, redundant for diagnostics).
    pub key_id: u8,
    /// Flag bits. Bit 0 = `is_decoy`. Bits 1-7 reserved.
    pub flags: u8,
    /// Reserved byte for future use (alignment).
    pub reserved: u8,
    /// Per-block random nonce (12 bytes).
    pub nonce: [u8; NONCE_LEN],
    /// Truncated SHA-256 of `header[0..14] || header[30..54] || block_index_le(4)`
    /// (first 12 bytes). Used as part of the AAD to bind the block to its index
    /// and to the header metadata (excluding `share_id`, which is backfilled).
    pub block_aad_hash: [u8; 12],
}

impl BlockIndexEntry {
    /// Returns `true` if this block is a decoy (random ciphertext).
    #[inline]
    pub fn is_decoy(&self) -> bool {
        (self.flags & FLAG_IS_DECOY) != 0
    }
}

/// Block index table + metadata parsed from the A00MPayload v0x51 header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkIndex {
    /// Plaintext block size in bytes (always `CHUNK_SIZE` for v5.1).
    pub chunk_size: u32,
    /// Total block count (including decoy blocks).
    pub block_count: u32,
    /// Real block count (excluding decoy blocks).
    pub real_block_count: u32,
    /// Decoy ratio in per-mille (recorded for diagnostics; not used at decrypt).
    pub decoy_ratio_permil: u16,
    /// Index entries, ordered by `offset` ascending.
    pub entries: Vec<BlockIndexEntry>,
}

// ----------------------------------------------------------------------------
// Algorithm rotation
// ----------------------------------------------------------------------------

/// Pick the algorithm ID for a given block index.
///
/// Even blocks → AES-256-GCM; odd blocks → ChaCha20-Poly1305.
#[inline]
pub fn algo_for_block(block_index: u32) -> u8 {
    if block_index.is_multiple_of(2) {
        ALGO_AES_256_GCM
    } else {
        ALGO_CHACHA20_POLY1305
    }
}

// ----------------------------------------------------------------------------
// Per-block key derivation (HKDF-SHA256)
// ----------------------------------------------------------------------------

/// Derive a 32-byte per-block key from the master password.
///
/// ```text
/// salt = SHA-256(author_member_id_le(8) || created_at_unix_le(8) || password_version(1))[0..16]
/// ikm  = master_password
/// info = b"A00M-v5.1-block-key"
///       || block_index_le(4)
///       || algo_id(1)
///       || chunk_size_le(4)
///       || is_decoy_flag(1)
/// key  = HKDF-Extract(salt, ikm) → HKDF-Expand(PRK, info, 32)
/// ```
///
/// `share_id` is deliberately excluded so the server can backfill it after
/// packaging without invalidating any block keys.
#[allow(clippy::too_many_arguments)]
pub fn derive_block_key(
    master_password: &[u8],
    author_member_id: i64,
    created_at_unix: i64,
    password_version: u8,
    block_index: u32,
    algo_id: u8,
    chunk_size: u32,
    is_decoy: bool,
) -> [u8; KEY_LEN] {
    use sha2::Digest;

    // salt = SHA-256(author_member_id || created_at_unix || password_version)[0..16]
    let mut hasher = sha2::Sha256::new();
    hasher.update(author_member_id.to_le_bytes());
    hasher.update(created_at_unix.to_le_bytes());
    hasher.update([password_version]);
    let salt_full = hasher.finalize();
    let salt = &salt_full[..16];

    // info = "A00M-v5.1-block-key" || block_index_le(4) || algo_id(1)
    //        || chunk_size_le(4) || is_decoy(1)
    let mut info = Vec::with_capacity(21);
    info.extend_from_slice(b"A00M-v5.1-block-key");
    info.extend_from_slice(&block_index.to_le_bytes());
    info.push(algo_id);
    info.extend_from_slice(&chunk_size.to_le_bytes());
    info.push(if is_decoy { 1u8 } else { 0u8 });

    // HKDF-SHA256
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), master_password);
    let mut okm = [0u8; KEY_LEN];
    // expand only fails if `okm.len() > 255 * HashLen(32) = 8160 bytes —
    // 32 bytes is always safe.
    hk.expand(&info, &mut okm)
        .expect("32-byte HKDF expand always succeeds");
    okm
}

// ----------------------------------------------------------------------------
// AEAD encrypt / decrypt primitives
// ----------------------------------------------------------------------------

/// Encrypt `plaintext` with the given key + nonce + AAD using the algorithm
/// identified by `algo_id`. Returns `ciphertext || tag(16)`.
pub fn encrypt_block(
    plaintext: &[u8],
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    algo_id: u8,
) -> Result<Vec<u8>> {
    match algo_id {
        ALGO_AES_256_GCM => {
            use aes_gcm::aead::{Aead, KeyInit, Payload};
            let cipher =
                aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
            cipher
                .encrypt(
                    aes_gcm::Nonce::from_slice(nonce),
                    Payload {
                        msg: plaintext,
                        aad,
                    },
                )
                .map_err(|e| anyhow::anyhow!("AES-256-GCM encrypt failed: {e}"))
        }
        ALGO_CHACHA20_POLY1305 => {
            use chacha20poly1305::aead::{Aead, KeyInit, Payload};
            let cipher =
                chacha20poly1305::ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(key));
            cipher
                .encrypt(
                    chacha20poly1305::Nonce::from_slice(nonce),
                    Payload {
                        msg: plaintext,
                        aad,
                    },
                )
                .map_err(|e| anyhow::anyhow!("ChaCha20-Poly1305 encrypt failed: {e}"))
        }
        other => bail!("unsupported algo_id: 0x{other:02x}"),
    }
}

/// Decrypt `ciphertext_with_tag` (ciphertext followed by the 16-byte tag) using
/// the given key + nonce + AAD. Returns the plaintext.
///
/// Fails if the tag does not verify (wrong key, tampered ciphertext, or
/// mismatched AAD).
pub fn decrypt_block(
    ciphertext_with_tag: &[u8],
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    algo_id: u8,
) -> Result<Vec<u8>> {
    if ciphertext_with_tag.len() < AEAD_TAG_LEN {
        bail!(
            "ciphertext too short: {} bytes (must be >= tag length {})",
            ciphertext_with_tag.len(),
            AEAD_TAG_LEN
        );
    }
    match algo_id {
        ALGO_AES_256_GCM => {
            use aes_gcm::aead::{Aead, KeyInit, Payload};
            let cipher =
                aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
            cipher
                .decrypt(
                    aes_gcm::Nonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext_with_tag,
                        aad,
                    },
                )
                .map_err(|e| {
                    anyhow::anyhow!("AES-256-GCM decrypt failed (wrong key or tampered): {e}")
                })
        }
        ALGO_CHACHA20_POLY1305 => {
            use chacha20poly1305::aead::{Aead, KeyInit, Payload};
            let cipher =
                chacha20poly1305::ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(key));
            cipher
                .decrypt(
                    chacha20poly1305::Nonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext_with_tag,
                        aad,
                    },
                )
                .map_err(|e| {
                    anyhow::anyhow!("ChaCha20-Poly1305 decrypt failed (wrong key or tampered): {e}")
                })
        }
        other => bail!("unsupported algo_id: 0x{other:02x}"),
    }
}

/// Generate a fresh random nonce using `OsRng`.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    nonce
}

// ----------------------------------------------------------------------------
// Decoy block generation
// ----------------------------------------------------------------------------

/// Generate a decoy block: random ciphertext + random 16-byte tag + random
/// 12-byte nonce.
///
/// Returns `(ciphertext_with_tag, nonce, algo_id)`. The `algo_id` is picked by
/// the same rotation rule as real blocks (`algo_for_block(block_index)`), so
/// attackers cannot distinguish decoy from real by examining the algorithm ID.
///
/// The decoy ciphertext length matches a real full-size block (`chunk_size +
/// AEAD_TAG_LEN`). For the last real block (which may be shorter), the caller
/// must adjust the length if it wants decoys to mimic short blocks; for
/// simplicity, we always generate full-size decoys.
pub fn generate_decoy_block(
    block_index: u32,
    chunk_size: u32,
    rng: &mut impl RngCore,
) -> (Vec<u8>, [u8; NONCE_LEN], u8) {
    let algo_id = algo_for_block(block_index);
    let mut ciphertext_with_tag = vec![0u8; chunk_size as usize + AEAD_TAG_LEN];
    rng.fill_bytes(&mut ciphertext_with_tag);
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce);
    (ciphertext_with_tag, nonce, algo_id)
}

/// Pick which block indices in the merged (real + decoy) array should be
/// decoys.
///
/// Returns a sorted `Vec<u32>` of decoy block indices. The indices are in
/// `[0, real_count + decoy_count)` where `decoy_count` is determined by
/// `ratio_permil`:
///
/// - `ratio_permil = 0` → no decoys (empty Vec)
/// - `ratio_permil = 1000` → all but one block is a decoy (`real_count - 1`)
/// - `ratio_permil = 100` → 10% decoys (target = `real_count / 10`)
///
/// The caller treats the remaining indices (those NOT in the returned Vec) as
/// real blocks, in ascending order.
pub fn pick_decoy_indices(real_count: u32, ratio_permil: u16, rng: &mut impl RngCore) -> Vec<u32> {
    if real_count == 0 || ratio_permil == 0 {
        return Vec::new();
    }
    // Compute target decoy count, capped at real_count - 1 (must leave ≥1 real block).
    let target = (u64::from(real_count) * u64::from(ratio_permil) / 1000) as u32;
    let max_decoys = real_count.saturating_sub(1);
    let decoy_count = target.min(max_decoys);

    if decoy_count == 0 {
        return Vec::new();
    }

    // Total positions in the merged array = real_count + decoy_count.
    let total = real_count + decoy_count;

    // Fisher-Yates shuffle to pick `decoy_count` unique indices from [0, total).
    let mut all_indices: Vec<u32> = (0..total).collect();
    for i in (1..total).rev() {
        // rng.next_u32() returns a uniform u32; modulo (i+1) gives a uniform index in [0, i].
        let j = rng.next_u32() % (i + 1);
        all_indices.swap(i as usize, j as usize);
    }

    let mut decoys: Vec<u32> = all_indices.into_iter().take(decoy_count as usize).collect();
    decoys.sort_unstable();
    decoys
}

// ----------------------------------------------------------------------------
// Index table serialization
// ----------------------------------------------------------------------------

/// Serialize a [`ChunkIndex`] to `N × 36` bytes (one entry per block).
///
/// Each entry is packed in little-endian:
/// `offset(4) || length(4) || algo_id(1) || key_id(1) || flags(1) || reserved(1)
/// || nonce(12) || block_aad_hash(12)` = 36 bytes total.
///
/// The header fields (`chunk_size`, `block_count`, `real_block_count`,
/// `decoy_ratio_permil`) are NOT serialized here — they live in the A00MPayload
/// header and are passed back into [`deserialize_index`] by the caller.
pub fn serialize_index(index: &ChunkIndex) -> Vec<u8> {
    let mut buf = Vec::with_capacity(index.entries.len() * BLOCK_INDEX_ENTRY_LEN);
    for entry in &index.entries {
        buf.extend_from_slice(&entry.offset.to_le_bytes());
        buf.extend_from_slice(&entry.length.to_le_bytes());
        buf.push(entry.algo_id);
        buf.push(entry.key_id);
        buf.push(entry.flags);
        buf.push(entry.reserved);
        buf.extend_from_slice(&entry.nonce);
        buf.extend_from_slice(&entry.block_aad_hash);
    }
    buf
}

/// Deserialize `N × 36` bytes into a [`ChunkIndex`].
///
/// The header-derived fields (`chunk_size`, `block_count`, `real_block_count`,
/// `decoy_ratio_permil`) are supplied by the caller — they are read from the
/// A00MPayload header, not from the index table bytes.
///
/// # Errors
///
/// Returns an error if `bytes.len()` does not exactly equal
/// `block_count * BLOCK_INDEX_ENTRY_LEN`.
pub fn deserialize_index(
    bytes: &[u8],
    chunk_size: u32,
    block_count: u32,
    real_block_count: u32,
    decoy_ratio_permil: u16,
) -> Result<ChunkIndex> {
    let expected_len = block_count as usize * BLOCK_INDEX_ENTRY_LEN;
    if bytes.len() != expected_len {
        bail!(
            "index bytes length mismatch: got {} expected {} (block_count={} × entry_len={})",
            bytes.len(),
            expected_len,
            block_count,
            BLOCK_INDEX_ENTRY_LEN
        );
    }

    let mut entries = Vec::with_capacity(block_count as usize);
    let mut cursor = 0;
    for _ in 0..block_count {
        // Slice lengths are guaranteed by the length check above, so expect()
        // is safe here.
        let offset = u32::from_le_bytes(
            bytes[cursor..cursor + 4]
                .try_into()
                .expect("cursor..cursor+4 is exactly 4 bytes"),
        );
        let length = u32::from_le_bytes(
            bytes[cursor + 4..cursor + 8]
                .try_into()
                .expect("cursor+4..cursor+8 is exactly 4 bytes"),
        );
        let algo_id = bytes[cursor + 8];
        let key_id = bytes[cursor + 9];
        let flags = bytes[cursor + 10];
        let reserved = bytes[cursor + 11];
        let nonce: [u8; NONCE_LEN] = bytes[cursor + 12..cursor + 24]
            .try_into()
            .expect("cursor+12..cursor+24 is exactly 12 bytes");
        let block_aad_hash: [u8; 12] = bytes[cursor + 24..cursor + 36]
            .try_into()
            .expect("cursor+24..cursor+36 is exactly 12 bytes");

        entries.push(BlockIndexEntry {
            offset,
            length,
            algo_id,
            key_id,
            flags,
            reserved,
            nonce,
            block_aad_hash,
        });
        cursor += BLOCK_INDEX_ENTRY_LEN;
    }

    Ok(ChunkIndex {
        chunk_size,
        block_count,
        real_block_count,
        decoy_ratio_permil,
        entries,
    })
}

// ----------------------------------------------------------------------------
// Decoy count helper (deterministic)
// ----------------------------------------------------------------------------

/// Deterministically compute how many decoy blocks will be generated for a
/// given `real_count` and `ratio_permil`.
///
/// This is the same formula used by [`pick_decoy_indices`], extracted so that
/// callers (e.g. `flac_container::write_flac_preview_container_chunked`) can
/// pre-compute `block_count = real_count + compute_decoy_count(...)` when
/// building the A00MPayload v0x51 header — the header must be fully populated
/// before encryption because it participates in the per-block AAD.
pub fn compute_decoy_count(real_count: u32, ratio_permil: u16) -> u32 {
    if real_count == 0 || ratio_permil == 0 {
        return 0;
    }
    let target = (u64::from(real_count) * u64::from(ratio_permil) / 1000) as u32;
    let max_decoys = real_count.saturating_sub(1);
    target.min(max_decoys)
}

// ----------------------------------------------------------------------------
// Per-block AAD computation
// ----------------------------------------------------------------------------

/// Compute `block_aad_hash = SHA-256(header[0..14] || header[30..54] ||
/// block_index_le(4))[0..12]`.
///
/// The `share_id` field (header[14..30]) is deliberately skipped so that the
/// server can backfill it via `fill_share_id_in_place` without invalidating
/// any block's AAD.
fn compute_block_aad_hash(header: &[u8], block_index: u32) -> [u8; 12] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&header[0..14]);
    hasher.update(&header[30..54]);
    hasher.update(block_index.to_le_bytes());
    let full = hasher.finalize();
    let mut out = [0u8; 12];
    out.copy_from_slice(&full[..12]);
    out
}

/// Compute the full AAD bytes for a block:
/// `header[0..14] || header[30..54] || block_index_le(4) || block_aad_hash[0..12]`.
///
/// `block_aad_hash` is read from the [`BlockIndexEntry`] (NOT recomputed) at
/// decrypt time, so that any tampering with the entry's position or the
/// header causes AAD mismatch → AEAD tag verification fails.
fn compute_block_aad(header: &[u8], block_index: u32, block_aad_hash: &[u8; 12]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(14 + 24 + 4 + 12);
    aad.extend_from_slice(&header[0..14]);
    aad.extend_from_slice(&header[30..54]);
    aad.extend_from_slice(&block_index.to_le_bytes());
    aad.extend_from_slice(block_aad_hash);
    aad
}

// ----------------------------------------------------------------------------
// Main pack / unpack API
// ----------------------------------------------------------------------------

/// Pack `rest.flac` plaintext into the v5.1 chunked encryption format.
///
/// Returns `(ChunkIndex, ciphertext_region_bytes)`. The caller is responsible
/// for serializing the header (54 bytes) + `serialize_index(&index)` +
/// `ciphertext_region` into the A00MPayload and embedding it in a FLAC
/// APPLICATION block.
///
/// `header` must be the fully-populated 54-byte v0x51 header (with `block_count`
/// and `real_block_count` already filled in). Use [`compute_decoy_count`] to
/// pre-compute `block_count = real_block_count + compute_decoy_count(...)`.
///
/// # Errors
///
/// Returns an error if any AEAD encryption fails (should not happen with valid
/// inputs) or if `header.len() != 54`.
#[allow(clippy::too_many_arguments)]
pub fn encrypt_rest_chunked(
    rest_flac_bytes: &[u8],
    master_password: &[u8],
    password_version: u8,
    author_member_id: i64,
    created_at_unix: i64,
    decoy_ratio_permil: u16,
    header: &[u8; 54],
) -> Result<(ChunkIndex, Vec<u8>)> {
    let chunk_size_u32 = CHUNK_SIZE as u32;

    // 1. Compute real block count (ceil division; empty input → 0 blocks).
    let real_block_count: u32 = if rest_flac_bytes.is_empty() {
        0
    } else {
        u32::try_from(rest_flac_bytes.len().div_ceil(CHUNK_SIZE))
            .map_err(|e| anyhow::anyhow!("plaintext too large for u32 block count: {e}"))?
    };

    // 2. Pick decoy block indices (deterministic count, random positions).
    let mut rng = rand::rngs::OsRng;
    let decoy_indices = pick_decoy_indices(real_block_count, decoy_ratio_permil, &mut rng);
    let decoy_count = decoy_indices.len() as u32;
    let total_block_count = real_block_count
        .checked_add(decoy_count)
        .ok_or_else(|| anyhow::anyhow!("block_count overflow"))?;

    // Sanity check: header field offsets (per v0x51 layout):
    //   [0..4] magic, [4] version, [5] password_version, [6..14] author_member_id,
    //   [14..30] share_id (skipped in AAD), [30..38] created_at_unix,
    //   [38..42] chunk_size, [42..46] block_count, [46..50] real_block_count,
    //   [50..52] decoy_ratio_permil, [52..54] reserved.
    let header_block_count = u32::from_le_bytes(
        header[42..46]
            .try_into()
            .expect("header[42..46] is exactly 4 bytes"),
    );
    let header_real_block_count = u32::from_le_bytes(
        header[46..50]
            .try_into()
            .expect("header[46..50] is exactly 4 bytes"),
    );
    if header_block_count != total_block_count {
        bail!(
            "header block_count mismatch: header says {} but encryption produced {} (real={} + decoy={})",
            header_block_count,
            total_block_count,
            real_block_count,
            decoy_count
        );
    }
    if header_real_block_count != real_block_count {
        bail!(
            "header real_block_count mismatch: header says {} but actual is {}",
            header_real_block_count,
            real_block_count
        );
    }

    // 3. Build a HashSet of decoy indices for O(1) membership test.
    let decoy_set: std::collections::HashSet<u32> = decoy_indices.iter().copied().collect();

    // 4. Iterate over the merged block_index sequence [0..total_block_count).
    let mut entries: Vec<BlockIndexEntry> = Vec::with_capacity(total_block_count as usize);
    let mut ciphertext_region: Vec<u8> =
        Vec::with_capacity(rest_flac_bytes.len() + (total_block_count as usize) * AEAD_TAG_LEN);
    let mut current_offset: u32 = 0;
    let mut real_block_idx: u32 = 0;

    for block_index in 0..total_block_count {
        let is_decoy = decoy_set.contains(&block_index);
        let algo_id = algo_for_block(block_index);
        let block_aad_hash = compute_block_aad_hash(header, block_index);

        let (ciphertext_with_tag, nonce, flags) = if is_decoy {
            // Decoy block: random ciphertext, random nonce. Don't encrypt anything.
            let (ct, nonce, _) = generate_decoy_block(block_index, chunk_size_u32, &mut rng);
            (ct, nonce, FLAG_IS_DECOY)
        } else {
            // Real block: take the next plaintext slice and encrypt it.
            let start = (real_block_idx as usize) * CHUNK_SIZE;
            let end = ((real_block_idx as usize) + 1) * CHUNK_SIZE;
            let end = end.min(rest_flac_bytes.len());
            let plaintext = &rest_flac_bytes[start..end];

            let key = derive_block_key(
                master_password,
                author_member_id,
                created_at_unix,
                password_version,
                block_index,
                algo_id,
                chunk_size_u32,
                false, // is_decoy
            );
            let nonce = random_nonce();
            let aad = compute_block_aad(header, block_index, &block_aad_hash);
            let ct = encrypt_block(plaintext, &key, &nonce, &aad, algo_id)?;
            real_block_idx += 1;
            (ct, nonce, 0u8)
        };

        let length = u32::try_from(ciphertext_with_tag.len())
            .map_err(|e| anyhow::anyhow!("ciphertext length overflow: {e}"))?;

        entries.push(BlockIndexEntry {
            offset: current_offset,
            length,
            algo_id,
            key_id: password_version,
            flags,
            reserved: 0,
            nonce,
            block_aad_hash,
        });

        ciphertext_region.extend_from_slice(&ciphertext_with_tag);
        current_offset = current_offset
            .checked_add(length)
            .ok_or_else(|| anyhow::anyhow!("ciphertext offset overflow"))?;
    }

    debug_assert_eq!(real_block_idx, real_block_count);

    let index = ChunkIndex {
        chunk_size: chunk_size_u32,
        block_count: total_block_count,
        real_block_count,
        decoy_ratio_permil,
        entries,
    };

    Ok((index, ciphertext_region))
}

/// Decrypt all real blocks (skipping decoys) and concatenate the plaintext.
///
/// Used by `decrypt_flac_preview_rest` for full-file decryption. For streaming
/// playback, use [`decrypt_block_range`] instead.
///
/// # Errors
///
/// Returns an error if any block's AEAD tag fails to verify (wrong password,
/// tampered ciphertext, or tampered header).
#[allow(clippy::too_many_arguments)]
pub fn decrypt_all_blocks(
    ciphertext_region: &[u8],
    index: &ChunkIndex,
    master_password: &[u8],
    author_member_id: i64,
    created_at_unix: i64,
    password_version: u8,
    header: &[u8; 54],
) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    for (block_index, entry) in index.entries.iter().enumerate() {
        if entry.is_decoy() {
            continue;
        }
        let block_index_u32 =
            u32::try_from(block_index).map_err(|e| anyhow::anyhow!("block_index overflow: {e}"))?;
        let ct_with_tag = ciphertext_region
            .get(entry.offset as usize..(entry.offset as usize) + entry.length as usize)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "block {} ciphertext out of range: offset={} length={} region={}",
                    block_index,
                    entry.offset,
                    entry.length,
                    ciphertext_region.len()
                )
            })?;
        let key = derive_block_key(
            master_password,
            author_member_id,
            created_at_unix,
            password_version,
            block_index_u32,
            entry.algo_id,
            index.chunk_size,
            false,
        );
        let aad = compute_block_aad(header, block_index_u32, &entry.block_aad_hash);
        let plaintext = decrypt_block(ct_with_tag, &key, &entry.nonce, &aad, entry.algo_id)?;
        out.extend_from_slice(&plaintext);
    }
    Ok(out)
}

/// Decrypt a contiguous range of real blocks `[block_start..=block_end]`
/// (0-based, indexing only real blocks, skipping decoys).
///
/// Used for streaming playback: the client downloads only the ciphertext for
/// the requested range and calls this function to decrypt it.
///
/// `block_start` and `block_end` are **real-block indices** (i.e. the i-th
/// real block, ignoring decoys). `block_end` is inclusive.
///
/// # Errors
///
/// Returns an error if the range is empty (`block_start > block_end`), out of
/// bounds (`block_end >= real_block_count`), or any block's AEAD tag fails.
#[allow(clippy::too_many_arguments)]
pub fn decrypt_block_range(
    ciphertext_region: &[u8],
    index: &ChunkIndex,
    master_password: &[u8],
    author_member_id: i64,
    created_at_unix: i64,
    password_version: u8,
    header: &[u8; 54],
    block_start: u32,
    block_end: u32,
) -> Result<Vec<u8>> {
    if block_start > block_end {
        bail!(
            "empty block range: block_start={} > block_end={}",
            block_start,
            block_end
        );
    }
    if block_end >= index.real_block_count {
        bail!(
            "block_end {} out of range (real_block_count={})",
            block_end,
            index.real_block_count
        );
    }

    // Filter real block entries in order, then take the [block_start..=block_end] slice.
    let real_entries: Vec<(usize, &BlockIndexEntry)> = index
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| !e.is_decoy())
        .collect();
    let real_count = real_entries.len() as u32;
    if block_end >= real_count {
        bail!(
            "block_end {} >= real entries {} (index inconsistency)",
            block_end,
            real_count
        );
    }

    let mut out: Vec<u8> = Vec::new();
    for i in block_start..=block_end {
        let (block_index, entry) = real_entries[i as usize];
        let block_index_u32 =
            u32::try_from(block_index).map_err(|e| anyhow::anyhow!("block_index overflow: {e}"))?;
        let ct_with_tag = ciphertext_region
            .get(entry.offset as usize..(entry.offset as usize) + entry.length as usize)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "block {} ciphertext out of range: offset={} length={} region={}",
                    block_index,
                    entry.offset,
                    entry.length,
                    ciphertext_region.len()
                )
            })?;
        let key = derive_block_key(
            master_password,
            author_member_id,
            created_at_unix,
            password_version,
            block_index_u32,
            entry.algo_id,
            index.chunk_size,
            false,
        );
        let aad = compute_block_aad(header, block_index_u32, &entry.block_aad_hash);
        let plaintext = decrypt_block(ct_with_tag, &key, &entry.nonce, &aad, entry.algo_id)?;
        out.extend_from_slice(&plaintext);
    }
    Ok(out)
}

/// Map a real-block range `[block_start..=block_end]` to a byte range
/// `(start_byte, end_byte)` in the ciphertext region.
///
/// Used by Phase D's HTTP Range proxy: the server can serve `Range: bytes=
/// start-end` directly from the on-disk ciphertext region without decrypting.
///
/// Returns `(0, 0)` if the range is empty or out of bounds. The returned byte
/// range covers all ciphertext+tag bytes for the requested real blocks
/// (decoy blocks between them are NOT included — callers needing contiguous
/// bytes should use `decrypt_block_range` instead).
pub fn block_range_to_byte_range(
    index: &ChunkIndex,
    block_start: u32,
    block_end: u32,
) -> (u64, u64) {
    if block_start > block_end || block_end >= index.real_block_count {
        return (0, 0);
    }
    let real_entries: Vec<&BlockIndexEntry> =
        index.entries.iter().filter(|e| !e.is_decoy()).collect();
    if block_end >= real_entries.len() as u32 {
        return (0, 0);
    }
    let start_entry = real_entries[block_start as usize];
    let end_entry = real_entries[block_end as usize];
    (
        u64::from(start_entry.offset),
        u64::from(end_entry.offset) + u64::from(end_entry.length),
    )
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_key() -> [u8; KEY_LEN] {
        let mut k = [0u8; KEY_LEN];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    fn dummy_nonce() -> [u8; NONCE_LEN] {
        let mut n = [0u8; NONCE_LEN];
        for (i, b) in n.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7);
        }
        n
    }

    #[test]
    fn algo_rotation_correct() {
        assert_eq!(algo_for_block(0), ALGO_AES_256_GCM);
        assert_eq!(algo_for_block(1), ALGO_CHACHA20_POLY1305);
        assert_eq!(algo_for_block(2), ALGO_AES_256_GCM);
        assert_eq!(algo_for_block(3), ALGO_CHACHA20_POLY1305);
        assert_eq!(algo_for_block(99), ALGO_CHACHA20_POLY1305);
        assert_eq!(algo_for_block(100), ALGO_AES_256_GCM);
    }

    #[test]
    fn key_derivation_deterministic() {
        let key1 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            7,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        let key2 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            7,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        assert_eq!(key1, key2, "same inputs must yield same key");
    }

    #[test]
    fn key_derivation_differs_per_block() {
        let k0 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            0,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        let k1 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            1,
            ALGO_CHACHA20_POLY1305,
            CHUNK_SIZE as u32,
            false,
        );
        let k2 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            2,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        assert_ne!(k0, k1, "block 0 and block 1 must differ");
        assert_ne!(k0, k2, "block 0 and block 2 must differ");
        assert_ne!(k1, k2, "block 1 and block 2 must differ");
    }

    #[test]
    fn key_derivation_differs_for_decoy() {
        let real_key = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            5,
            ALGO_CHACHA20_POLY1305,
            CHUNK_SIZE as u32,
            false,
        );
        let decoy_key = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            5,
            ALGO_CHACHA20_POLY1305,
            CHUNK_SIZE as u32,
            true,
        );
        assert_ne!(
            real_key, decoy_key,
            "real and decoy blocks must use different keys"
        );
    }

    #[test]
    fn key_derivation_differs_per_password_version() {
        let k_v1 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            0,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        let k_v2 = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            2,
            0,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        assert_ne!(
            k_v1, k_v2,
            "different password_version must yield different keys"
        );
    }

    #[test]
    fn key_derivation_excludes_share_id() {
        // share_id is not a parameter — derivation must be independent of share_id.
        // This test is a tautology but documents the contract.
        let key = derive_block_key(
            b"master-password",
            12345,
            1700000000,
            1,
            0,
            ALGO_AES_256_GCM,
            CHUNK_SIZE as u32,
            false,
        );
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn single_block_round_trip_aes_gcm() {
        let plaintext = b"hello, v5.1 chunked encryption world!";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"some-aad-binding";

        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_AES_256_GCM)
            .expect("encrypt must succeed");
        assert_eq!(ct.len(), plaintext.len() + AEAD_TAG_LEN);

        let pt =
            decrypt_block(&ct, &key, &nonce, aad, ALGO_AES_256_GCM).expect("decrypt must succeed");
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn single_block_round_trip_chacha20() {
        let plaintext = b"hello, v5.1 chunked encryption world!";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"some-aad-binding";

        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_CHACHA20_POLY1305)
            .expect("encrypt must succeed");
        assert_eq!(ct.len(), plaintext.len() + AEAD_TAG_LEN);

        let pt = decrypt_block(&ct, &key, &nonce, aad, ALGO_CHACHA20_POLY1305)
            .expect("decrypt must succeed");
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn empty_plaintext_round_trip() {
        let plaintext: &[u8] = b"";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"aad";

        for algo in [ALGO_AES_256_GCM, ALGO_CHACHA20_POLY1305] {
            let ct = encrypt_block(plaintext, &key, &nonce, aad, algo)
                .unwrap_or_else(|e| panic!("encrypt algo {algo} failed: {e}"));
            assert_eq!(ct.len(), AEAD_TAG_LEN, "empty plaintext → tag only");
            let pt = decrypt_block(&ct, &key, &nonce, aad, algo)
                .unwrap_or_else(|e| panic!("decrypt algo {algo} failed: {e}"));
            assert!(pt.is_empty());
        }
    }

    #[test]
    fn large_block_round_trip() {
        // ~1 MiB plaintext to exercise both algorithms with realistic size
        let plaintext: Vec<u8> = (0..(1024 * 1024)).map(|i| (i & 0xFF) as u8).collect();
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"large-block-aad";

        for algo in [ALGO_AES_256_GCM, ALGO_CHACHA20_POLY1305] {
            let ct = encrypt_block(&plaintext, &key, &nonce, aad, algo)
                .unwrap_or_else(|e| panic!("encrypt algo {algo} failed: {e}"));
            assert_eq!(ct.len(), plaintext.len() + AEAD_TAG_LEN);
            let pt = decrypt_block(&ct, &key, &nonce, aad, algo)
                .unwrap_or_else(|e| panic!("decrypt algo {algo} failed: {e}"));
            assert_eq!(pt, plaintext, "algo {algo} round-trip mismatch");
        }
    }

    #[test]
    fn wrong_key_fails() {
        let plaintext = b"secret";
        let key = dummy_key();
        let wrong_key = {
            let mut k = dummy_key();
            k[0] ^= 0xFF;
            k
        };
        let nonce = dummy_nonce();
        let aad = b"aad";

        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_AES_256_GCM).unwrap();

        let err = decrypt_block(&ct, &wrong_key, &nonce, aad, ALGO_AES_256_GCM)
            .expect_err("wrong key must fail");
        let msg = format!("{err}");
        assert!(
            msg.contains("decrypt failed"),
            "error should mention decrypt failure: {msg}"
        );
    }

    #[test]
    fn wrong_algo_fails() {
        let plaintext = b"secret";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"aad";

        // Encrypt with AES-GCM, try to decrypt with ChaCha20 — tag must fail.
        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_AES_256_GCM).unwrap();
        let err = decrypt_block(&ct, &key, &nonce, aad, ALGO_CHACHA20_POLY1305)
            .expect_err("mismatched algo must fail");
        let _ = format!("{err}");
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let plaintext = b"tamper-test-payload";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"aad";

        let mut ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_AES_256_GCM).unwrap();
        // Flip a bit in the middle of the ciphertext.
        let mid = ct.len() / 2;
        ct[mid] ^= 0x01;

        let err = decrypt_block(&ct, &key, &nonce, aad, ALGO_AES_256_GCM)
            .expect_err("tampered ciphertext must fail");
        let _ = format!("{err}");
    }

    #[test]
    fn tampered_aad_fails() {
        let plaintext = b"aad-tamper-test";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"original-aad";

        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_AES_256_GCM).unwrap();

        let err = decrypt_block(&ct, &key, &nonce, b"tampered-aad", ALGO_AES_256_GCM)
            .expect_err("tampered AAD must fail");
        let _ = format!("{err}");
    }

    #[test]
    fn tampered_nonce_fails() {
        let plaintext = b"nonce-tamper-test";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"aad";

        let ct = encrypt_block(plaintext, &key, &nonce, aad, ALGO_CHACHA20_POLY1305).unwrap();

        let mut wrong_nonce = nonce;
        wrong_nonce[0] ^= 0xFF;
        let err = decrypt_block(&ct, &key, &wrong_nonce, aad, ALGO_CHACHA20_POLY1305)
            .expect_err("tampered nonce must fail");
        let _ = format!("{err}");
    }

    #[test]
    fn unsupported_algo_returns_error() {
        let plaintext = b"x";
        let key = dummy_key();
        let nonce = dummy_nonce();
        let aad = b"aad";

        let err = encrypt_block(plaintext, &key, &nonce, aad, 0xFF)
            .expect_err("unsupported algo must fail");
        assert!(format!("{err}").contains("unsupported algo_id"));

        // Use a ciphertext long enough to pass the length check (>= AEAD_TAG_LEN)
        // so the algo_id dispatch is actually reached.
        let long_ciphertext = vec![0u8; AEAD_TAG_LEN + 1];
        let err = decrypt_block(&long_ciphertext, &key, &nonce, aad, 0xFE)
            .expect_err("unsupported algo must fail");
        assert!(format!("{err}").contains("unsupported algo_id"));
    }

    #[test]
    fn decrypt_too_short_ciphertext_fails() {
        let key = dummy_key();
        let nonce = dummy_nonce();
        let short = vec![0u8; AEAD_TAG_LEN - 1];
        let err = decrypt_block(&short, &key, &nonce, b"", ALGO_AES_256_GCM)
            .expect_err("too-short ciphertext must fail");
        assert!(format!("{err}").contains("too short"));
    }

    #[test]
    fn random_nonce_produces_different_values() {
        let n1 = random_nonce();
        let n2 = random_nonce();
        // Probability of collision is 2^-96 — effectively impossible.
        assert_ne!(n1, n2, "OsRng must produce different nonces");
    }

    #[test]
    fn block_index_entry_is_decoy_flag() {
        let mut entry = BlockIndexEntry {
            offset: 0,
            length: 100,
            algo_id: ALGO_AES_256_GCM,
            key_id: 1,
            flags: 0,
            reserved: 0,
            nonce: [0u8; NONCE_LEN],
            block_aad_hash: [0u8; 12],
        };
        assert!(!entry.is_decoy());
        entry.flags = FLAG_IS_DECOY;
        assert!(entry.is_decoy());
        // Combined flags should still detect decoy.
        entry.flags = FLAG_IS_DECOY | 0x80;
        assert!(entry.is_decoy());
    }

    // ---- Step 3: decoy block generation + index serialization ----

    #[test]
    fn decoy_block_has_correct_length() {
        let mut rng = rand::rngs::OsRng;
        let chunk_size = CHUNK_SIZE as u32;
        let (ct, _nonce, _algo) = generate_decoy_block(0, chunk_size, &mut rng);
        assert_eq!(
            ct.len(),
            chunk_size as usize + AEAD_TAG_LEN,
            "decoy ciphertext must be chunk_size + 16 (tag)"
        );
    }

    #[test]
    fn decoy_block_algo_matches_rotation() {
        let mut rng = rand::rngs::OsRng;
        // Even block index → AES-256-GCM
        let (_ct, _nonce, algo_even) = generate_decoy_block(2, CHUNK_SIZE as u32, &mut rng);
        assert_eq!(algo_even, ALGO_AES_256_GCM);
        // Odd block index → ChaCha20-Poly1305
        let (_ct, _nonce, algo_odd) = generate_decoy_block(7, CHUNK_SIZE as u32, &mut rng);
        assert_eq!(algo_odd, ALGO_CHACHA20_POLY1305);
    }

    #[test]
    fn decoy_block_ciphertext_is_random() {
        let mut rng = rand::rngs::OsRng;
        let (ct1, nonce1, _) = generate_decoy_block(0, CHUNK_SIZE as u32, &mut rng);
        let (ct2, nonce2, _) = generate_decoy_block(0, CHUNK_SIZE as u32, &mut rng);
        assert_ne!(ct1, ct2, "two decoy ciphertexts must differ (random)");
        assert_ne!(nonce1, nonce2, "two decoy nonces must differ (random)");
    }

    #[test]
    fn pick_decoy_indices_ratio_zero() {
        let mut rng = rand::rngs::OsRng;
        let decoys = pick_decoy_indices(100, 0, &mut rng);
        assert!(decoys.is_empty(), "ratio_permil=0 must return empty Vec");
    }

    #[test]
    fn pick_decoy_indices_ratio_full() {
        let mut rng = rand::rngs::OsRng;
        let real_count: u32 = 50;
        let decoys = pick_decoy_indices(real_count, 1000, &mut rng);
        // ratio=1000 → target = 50, but max = real_count - 1 = 49
        assert_eq!(
            decoys.len(),
            (real_count - 1) as usize,
            "ratio_permil=1000 must leave exactly 1 real block"
        );
    }

    #[test]
    fn pick_decoy_indices_approx_correct() {
        let mut rng = rand::rngs::OsRng;
        let real_count: u32 = 1000;
        let decoys = pick_decoy_indices(real_count, 100, &mut rng);
        // target = 1000 * 100 / 1000 = 100; allow [85, 115] for safety
        let n = decoys.len();
        assert!(
            (85..=115).contains(&n),
            "decoy count for 1000 real blocks at ratio=100 should be ~100, got {n}"
        );
    }

    #[test]
    fn pick_decoy_indices_are_unique() {
        let mut rng = rand::rngs::OsRng;
        let decoys = pick_decoy_indices(100, 100, &mut rng);
        let mut seen = std::collections::HashSet::new();
        for idx in &decoys {
            assert!(
                seen.insert(*idx),
                "duplicate decoy index {idx} — uniqueness violated"
            );
        }
    }

    #[test]
    fn pick_decoy_indices_are_sorted() {
        let mut rng = rand::rngs::OsRng;
        let decoys = pick_decoy_indices(100, 100, &mut rng);
        let mut sorted = decoys.clone();
        sorted.sort_unstable();
        assert_eq!(decoys, sorted, "decoy indices must be returned sorted");
    }

    #[test]
    fn serialize_index_round_trip() {
        let entries = vec![
            BlockIndexEntry {
                offset: 54,
                length: 1000,
                algo_id: ALGO_AES_256_GCM,
                key_id: 1,
                flags: 0,
                reserved: 0,
                nonce: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                block_aad_hash: [0xAA; 12],
            },
            BlockIndexEntry {
                offset: 1070,
                length: 500,
                algo_id: ALGO_CHACHA20_POLY1305,
                key_id: 1,
                flags: FLAG_IS_DECOY,
                reserved: 0,
                nonce: [0xBB; 12],
                block_aad_hash: [0xCC; 12],
            },
        ];
        let index = ChunkIndex {
            chunk_size: CHUNK_SIZE as u32,
            block_count: 2,
            real_block_count: 1,
            decoy_ratio_permil: 500,
            entries,
        };
        let bytes = serialize_index(&index);
        assert_eq!(bytes.len(), 2 * BLOCK_INDEX_ENTRY_LEN);

        let decoded = deserialize_index(&bytes, CHUNK_SIZE as u32, 2, 1, 500)
            .expect("deserialize must succeed");
        assert_eq!(decoded, index, "round-trip must preserve all fields");
    }

    #[test]
    fn deserialize_index_too_short_fails() {
        // Claim block_count=2 (needs 72 bytes) but only provide 36 bytes.
        let short_bytes = vec![0u8; 36];
        let err = deserialize_index(&short_bytes, CHUNK_SIZE as u32, 2, 1, 100)
            .expect_err("too-short bytes must fail");
        assert!(
            format!("{err}").contains("length mismatch"),
            "error should mention length mismatch: {err}"
        );
    }

    #[test]
    fn deserialize_index_wrong_length_fails() {
        // Provide 37 bytes (not a multiple of 36) with block_count=1 (expects 36).
        let wrong_bytes = vec![0u8; 37];
        let err = deserialize_index(&wrong_bytes, CHUNK_SIZE as u32, 1, 1, 100)
            .expect_err("non-multiple-of-36 bytes must fail");
        assert!(
            format!("{err}").contains("length mismatch"),
            "error should mention length mismatch: {err}"
        );
    }

    // ------------------------------------------------------------------------
    // Step 4 tests: encrypt_rest_chunked / decrypt_all_blocks /
    //                decrypt_block_range / block_range_to_byte_range
    // ------------------------------------------------------------------------

    /// Build a 54-byte v0x51 test header with the given block counts.
    /// Other fields are filled with deterministic test values.
    fn make_test_header_with_counts(block_count: u32, real_block_count: u32) -> [u8; 54] {
        let mut h = [0u8; 54];
        h[0..4].copy_from_slice(b"A00M");
        h[4] = 0x51; // version
        h[5] = 1; // password_version
        h[6..14].copy_from_slice(&12345i64.to_le_bytes()); // author_member_id
                                                           // share_id [14..30] = zeros (skipped in AAD, OK)
        h[30..38].copy_from_slice(&1700000000i64.to_le_bytes()); // created_at_unix
        h[38..42].copy_from_slice(&(CHUNK_SIZE as u32).to_le_bytes()); // chunk_size
        h[42..46].copy_from_slice(&block_count.to_le_bytes());
        h[46..50].copy_from_slice(&real_block_count.to_le_bytes());
        h[50..52].copy_from_slice(&100u16.to_le_bytes()); // decoy_ratio_permil
        h[52..54].copy_from_slice(&0u16.to_le_bytes()); // reserved
        h
    }

    /// Build a 54-byte v0x51 test header with correct block_count derived
    /// from `plaintext_len` and `decoy_ratio_permil`.
    fn make_test_header(plaintext_len: usize, decoy_ratio_permil: u16) -> [u8; 54] {
        let real = if plaintext_len == 0 {
            0
        } else {
            u32::try_from(plaintext_len.div_ceil(CHUNK_SIZE)).unwrap()
        };
        let decoy = compute_decoy_count(real, decoy_ratio_permil);
        let total = real + decoy;
        let mut h = make_test_header_with_counts(total, real);
        h[50..52].copy_from_slice(&decoy_ratio_permil.to_le_bytes());
        h
    }

    #[test]
    fn encrypt_rest_single_block_no_decoy() {
        // 1 KB plaintext, ratio=0 → 1 real block, 0 decoys.
        let plaintext = vec![0x42u8; 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt must succeed");
        assert_eq!(index.real_block_count, 1);
        assert_eq!(index.block_count, 1);
        assert_eq!(index.entries.len(), 1);
        assert!(!index.entries[0].is_decoy());
        // ciphertext length = plaintext + 16-byte tag
        assert_eq!(ciphertext.len(), 1024 + AEAD_TAG_LEN);
    }

    #[test]
    fn encrypt_rest_multi_block_with_decoy() {
        // 600 KB plaintext (3 full blocks), ratio=300 → target=0 decoys (3*300/1000=0).
        // Use ratio=500 → target = 3*500/1000 = 1, capped at min(1, 2) = 1 decoy.
        let plaintext = vec![0x55u8; 600 * 1024];
        let header = make_test_header(plaintext.len(), 500);
        let (index, _ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 500, &header)
                .expect("encrypt must succeed");
        assert_eq!(index.real_block_count, 3);
        assert!(index.block_count >= 3, "block_count >= 3");
        let decoy_count = index.entries.iter().filter(|e| e.is_decoy()).count();
        assert!(
            decoy_count >= 1,
            "expected at least 1 decoy, got {decoy_count}"
        );
    }

    #[test]
    fn encrypt_rest_last_block_partial() {
        // 300 KB plaintext: 1 full block (256 KB) + 1 partial block (44 KB).
        let plaintext = vec![0x77u8; 300 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, _ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt must succeed");
        assert_eq!(index.real_block_count, 2);
        assert_eq!(index.block_count, 2);
        // First block: full size (CHUNK_SIZE + tag)
        assert_eq!(index.entries[0].length as usize, CHUNK_SIZE + AEAD_TAG_LEN);
        // Second block: partial (44 KB + tag)
        assert_eq!(index.entries[1].length as usize, 44 * 1024 + AEAD_TAG_LEN);
    }

    #[test]
    fn decrypt_all_matches_encrypt() {
        // 100 KB plaintext, ratio=0 → single block, no decoys.
        let plaintext = vec![0xABu8; 100 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        let decrypted = decrypt_all_blocks(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &header,
        )
        .expect("decrypt");
        assert_eq!(decrypted, plaintext, "decrypted must match original");
    }

    #[test]
    fn decrypt_all_skips_decoy() {
        // 600 KB plaintext (3 real blocks), ratio=500 → 1 decoy.
        // decrypt_all output length must equal plaintext length (decoys skipped).
        let plaintext = vec![0x33u8; 600 * 1024];
        let header = make_test_header(plaintext.len(), 500);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 500, &header)
                .expect("encrypt");
        let decrypted = decrypt_all_blocks(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &header,
        )
        .expect("decrypt");
        assert_eq!(
            decrypted.len(),
            plaintext.len(),
            "decrypted length must match original (decoys skipped)"
        );
        assert_eq!(decrypted, plaintext, "decrypted content must match");
    }

    #[test]
    fn decrypt_block_range_first_3() {
        // 800 KB plaintext (4 real blocks), ratio=0 → 4 real, 0 decoy.
        // Decrypt real blocks [0..=2] → first 3*CHUNK_SIZE bytes.
        let plaintext = vec![0x99u8; 800 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        assert_eq!(index.real_block_count, 4); // 800KB / 256KB = 3.125 → 4 blocks
        let decrypted_range = decrypt_block_range(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &header,
            0,
            2,
        )
        .expect("decrypt range");
        assert_eq!(
            decrypted_range.len(),
            3 * CHUNK_SIZE,
            "first 3 real blocks = 3*CHUNK_SIZE bytes"
        );
        assert_eq!(
            decrypted_range.as_slice(),
            &plaintext[0..3 * CHUNK_SIZE],
            "content must match first 3 blocks"
        );
    }

    #[test]
    fn decrypt_block_range_last_block() {
        // 800 KB plaintext (4 real blocks), ratio=0.
        // Decrypt real block [3..=3] → last partial block.
        let plaintext = vec![0x99u8; 800 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        let decrypted_range = decrypt_block_range(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &header,
            3,
            3,
        )
        .expect("decrypt range");
        let expected = &plaintext[3 * CHUNK_SIZE..];
        assert_eq!(
            decrypted_range.as_slice(),
            expected,
            "last block must match"
        );
    }

    #[test]
    fn decrypt_wrong_password_fails() {
        let plaintext = vec![0x11u8; 50 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"correct-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        let err = decrypt_all_blocks(
            &ciphertext,
            &index,
            b"wrong-pw",
            12345,
            1700000000,
            1,
            &header,
        )
        .expect_err("wrong password must fail");
        let msg = format!("{err}");
        assert!(
            msg.contains("decrypt failed") || msg.contains("wrong key"),
            "error should mention decrypt failure: {msg}"
        );
    }

    #[test]
    fn decrypt_tampered_ciphertext_fails() {
        let plaintext = vec![0x22u8; 50 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, mut ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        // Flip the first byte of the ciphertext region.
        ciphertext[0] ^= 0xFF;
        let err = decrypt_all_blocks(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &header,
        )
        .expect_err("tampered ciphertext must fail");
        let msg = format!("{err}");
        assert!(
            msg.contains("decrypt failed"),
            "error should mention decrypt failure: {msg}"
        );
    }

    #[test]
    fn decrypt_tampered_header_fails() {
        let plaintext = vec![0x44u8; 50 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        // Tamper with header[5] (password_version) — this is in the AAD region [0..14].
        let mut tampered_header = header;
        tampered_header[5] ^= 0x01;
        let err = decrypt_all_blocks(
            &ciphertext,
            &index,
            b"master-pw",
            12345,
            1700000000,
            1,
            &tampered_header,
        )
        .expect_err("tampered header must fail AAD verification");
        let msg = format!("{err}");
        assert!(
            msg.contains("decrypt failed"),
            "error should mention decrypt failure: {msg}"
        );
    }

    #[test]
    fn block_range_to_byte_range_correct() {
        // 300 KB plaintext (2 real blocks: 256KB + 44KB), ratio=0.
        let plaintext = vec![0x88u8; 300 * 1024];
        let header = make_test_header(plaintext.len(), 0);
        let (index, _ciphertext) =
            encrypt_rest_chunked(&plaintext, b"master-pw", 1, 12345, 1700000000, 0, &header)
                .expect("encrypt");
        assert_eq!(index.real_block_count, 2);

        // Block 0: offset=0, length=CHUNK_SIZE+tag
        // Block 1: offset=CHUNK_SIZE+tag, length=44*1024+tag
        let (start, end) = block_range_to_byte_range(&index, 0, 0);
        assert_eq!(start, 0);
        assert_eq!(end, (CHUNK_SIZE + AEAD_TAG_LEN) as u64);

        let (start, end) = block_range_to_byte_range(&index, 1, 1);
        assert_eq!(start, (CHUNK_SIZE + AEAD_TAG_LEN) as u64);
        assert_eq!(
            end,
            (CHUNK_SIZE + AEAD_TAG_LEN + 44 * 1024 + AEAD_TAG_LEN) as u64
        );

        let (start, end) = block_range_to_byte_range(&index, 0, 1);
        assert_eq!(start, 0);
        assert_eq!(
            end,
            (CHUNK_SIZE + AEAD_TAG_LEN + 44 * 1024 + AEAD_TAG_LEN) as u64
        );

        // Out-of-bounds returns (0, 0).
        let (start, end) = block_range_to_byte_range(&index, 0, 5);
        assert_eq!(start, 0);
        assert_eq!(end, 0);
    }
}
