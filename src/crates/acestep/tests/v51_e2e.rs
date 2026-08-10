//! End-to-end integration test for `.a00m` v5.1 chunked encryption.
//!
//! Verifies the full pipeline: synthetic PCM → v0x51 pack → file I/O →
//! read_chunk_index → decrypt_block_range → decrypt_flac_preview_rest →
//! verify decrypted bytes match.

use acestep::flac_container::{
    compute_content_hash, decrypt_block_range, decrypt_flac_preview_rest, fill_share_id_in_place,
    read_chunk_index, read_password_version, write_flac_preview_container_chunked,
};

const PASSWORD: &[u8] = b"e2e-test-password-for-v5.1-chunked";

/// LCG pseudo-random samples — nearly incompressible by FLAC, ensures the
/// rest.flac payload spans multiple 256 KiB blocks.
fn make_noise_samples(duration_secs: f32, sample_rate: usize, channels: usize) -> Vec<i32> {
    let n_frames = (duration_secs * sample_rate as f32) as usize;
    let mut out = Vec::with_capacity(n_frames * channels);
    // Simple LCG random — deterministic across runs for reproducible tests.
    // Uses glibc LCG constants (same as flac_container::tests::make_noise_samples).
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
fn v51_e2e_full_pipeline_round_trip() {
    let sample_rate = 44100;
    let channels = 2;
    let bits_per_sample = 16;
    // 15s @ 44100 Hz stereo = ~2.5 MB PCM → rest.flac ~2 MB → 8+ blocks.
    let full_samples = make_noise_samples(15.0, sample_rate, channels);
    let trailer_samples = make_noise_samples(0.5, sample_rate, channels);

    // 1. Pack as v0x51 with ratio=500 (50% decoy — ensures decoys even with
    //    few real blocks, since compute_decoy_count uses integer division).
    let mut flac_bytes = write_flac_preview_container_chunked(
        &full_samples,
        sample_rate,
        channels,
        bits_per_sample,
        &trailer_samples,
        1.0, // preview_duration_secs (rest spans 14s)
        PASSWORD,
        1,             // password_version
        42,            // author_member_id
        [0; 16],       // share_id = zero (not yet registered)
        1_700_000_000, // created_at_unix
        500,           // decoy_ratio_permil = 50%
    )
    .expect("v0x51 pack should succeed");

    // 2. Read password_version — should be 1.
    let pv = read_password_version(&flac_bytes).unwrap().unwrap();
    assert_eq!(pv, 1);

    // 3. Read chunk index — should be Some with multiple real blocks.
    let index = read_chunk_index(&flac_bytes)
        .unwrap()
        .expect("index should be present");
    assert!(
        index.real_block_count >= 3,
        "need >=3 real blocks for range test"
    );
    assert!(
        index.block_count >= index.real_block_count,
        "block_count >= real_block_count"
    );
    // With ratio=100, expect some decoy blocks.
    assert!(
        index.block_count > index.real_block_count,
        "decoy blocks should exist with ratio=100"
    );
    // Every entry should have a valid algo_id (1 or 2).
    for e in &index.entries {
        assert!(
            e.algo_id == 1 || e.algo_id == 2,
            "invalid algo_id {}",
            e.algo_id
        );
    }

    // 4. Compute content hash before backfill — must differ after backfill.
    let hash_before = compute_content_hash(&flac_bytes);

    // 5. Backfill share_id (simulates server registration).
    let share_id: [u8; 16] = [
        0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE,
        0xF0,
    ];
    fill_share_id_in_place(&mut flac_bytes, share_id).unwrap();
    let hash_after = compute_content_hash(&flac_bytes);
    assert_ne!(
        hash_before, hash_after,
        "hash should differ after share_id backfill"
    );

    // 6. Full decryption via decrypt_flac_preview_rest — should produce valid FLAC.
    let (rest_flac, copyright) =
        decrypt_flac_preview_rest(&flac_bytes, PASSWORD).expect("full decrypt should succeed");
    assert!(!rest_flac.is_empty());
    assert_eq!(
        &rest_flac[0..4],
        b"fLaC",
        "rest should be a valid FLAC stream"
    );
    assert_eq!(copyright.share_id, share_id);
    assert_eq!(copyright.author_member_id, 42);
    assert_eq!(copyright.password_version, 1);

    // 7. Range decryption — decrypt first 3 real blocks, compare prefix with full.
    let range_bytes =
        decrypt_block_range(&flac_bytes, PASSWORD, 0, 2).expect("range decrypt should succeed");
    // Range bytes should be a prefix of full rest_flac (first 3 blocks = 3 * CHUNK_SIZE bytes,
    // possibly less if block 2 is the last block).
    let expected_prefix_len = range_bytes.len();
    assert!(
        expected_prefix_len > 0 && expected_prefix_len <= rest_flac.len(),
        "range len {expected_prefix_len} should be within rest len {}",
        rest_flac.len()
    );
    assert_eq!(
        &range_bytes[..],
        &rest_flac[..expected_prefix_len],
        "range decrypt should match prefix of full decrypt"
    );

    // 8. Wrong password should fail.
    let wrong = decrypt_flac_preview_rest(&flac_bytes, b"wrong-password");
    assert!(wrong.is_err(), "wrong password should fail");
}

#[test]
fn v51_e2e_v50_backward_compat() {
    // Ensure v0x50 files still work: read_chunk_index returns None,
    // decrypt_block_range returns an error.
    use acestep::flac_container::write_flac_preview_container;

    let sample_rate = 8000;
    let channels = 1;
    let bits_per_sample = 16;
    let full_samples = make_noise_samples(2.0, sample_rate, channels);
    let trailer_samples = make_noise_samples(0.2, sample_rate, channels);

    let flac_bytes = write_flac_preview_container(
        &full_samples,
        sample_rate,
        channels,
        bits_per_sample,
        &trailer_samples,
        1.0,
        PASSWORD,
        1,
        42,
        [0xAB; 16],
        1_700_000_000,
    )
    .unwrap();

    // v0x50 file → read_chunk_index returns None.
    let index = read_chunk_index(&flac_bytes).unwrap();
    assert!(index.is_none(), "v0x50 should return None for chunk index");

    // v0x50 file → decrypt_block_range returns an error mentioning v0x50.
    let err = decrypt_block_range(&flac_bytes, PASSWORD, 0, 0).unwrap_err();
    assert!(
        err.to_string().contains("v0x50"),
        "error should mention v0x50, got: {err}"
    );
}
