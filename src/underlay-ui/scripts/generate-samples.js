/**
 * Generate Sample Audio Files
 * 
 * This script generates basic audio samples for testing the sampler system.
 * In production, these would be replaced with high-quality recorded samples.
 */

// Simple function to generate a sine wave audio buffer
function generateTone(frequency, duration, sampleRate = 44100) {
  const length = sampleRate * duration;
  const buffer = new Float32Array(length);
  
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Add some harmonics for more interesting sound
    buffer[i] = 
      0.5 * Math.sin(2 * Math.PI * frequency * t) +
      0.2 * Math.sin(2 * Math.PI * frequency * 2 * t) +
      0.1 * Math.sin(2 * Math.PI * frequency * 3 * t);
    
    // Apply envelope (attack, decay, sustain, release)
    const attackTime = 0.1;
    const releaseTime = 0.2;
    let envelope = 1;
    
    if (t < attackTime) {
      envelope = t / attackTime;
    } else if (t > duration - releaseTime) {
      envelope = (duration - t) / releaseTime;
    }
    
    buffer[i] *= envelope * 0.3; // Reduce volume
  }
  
  return buffer;
}

// Generate whistle samples (higher frequencies, pure tones)
function generateWhistleSample(note, frequency) {
  const buffer = generateTone(frequency, 1.5);
  
  // Apply whistle-like filtering (emphasize higher harmonics)
  for (let i = 0; i < buffer.length; i++) {
    const t = i / 44100;
    // Add slight vibrato
    const vibrato = 1 + 0.02 * Math.sin(2 * Math.PI * 5 * t);
    buffer[i] *= vibrato;
  }
  
  return buffer;
}

// Generate harmonica samples (richer harmonics, breath-like)
function generateHarmonicaSample(note, frequency) {
  const buffer = generateTone(frequency, 2.0);
  
  // Add harmonica-like characteristics
  for (let i = 0; i < buffer.length; i++) {
    const t = i / 44100;
    // Add breath noise
    const noise = (Math.random() - 0.5) * 0.05;
    // Add slight tremolo
    const tremolo = 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t);
    buffer[i] = buffer[i] * tremolo + noise;
  }
  
  return buffer;
}

// Note frequencies (C4 to C5)
const noteFrequencies = {
  'c4': 261.63,
  'd4': 293.66,
  'e4': 329.63,
  'f4': 349.23,
  'g4': 392.00,
  'a4': 440.00,
  'b4': 493.88,
  'c5': 523.25
};

console.log('Sample generation script loaded.');
console.log('Note: This generates basic synthetic samples for testing.');
console.log('For production, replace with high-quality recorded samples from:');
console.log('- Freesound.org (CC0 licensed)');
console.log('- Philharmonia Orchestra samples');
console.log('- University of Iowa Electronic Music Studios');

// Export for use in browser
if (typeof module !== 'undefined') {
  module.exports = {
    generateWhistleSample,
    generateHarmonicaSample,
    noteFrequencies
  };
}