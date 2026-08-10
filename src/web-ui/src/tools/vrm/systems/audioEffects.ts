export function playRecordingStartSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioContext = new AudioContextClass()

    const oscillator1 = audioContext.createOscillator()
    const oscillator2 = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator1.connect(gainNode)
    oscillator2.connect(gainNode)
    gainNode.connect(audioContext.destination)

    oscillator1.type = 'sine'
    oscillator2.type = 'sine'

    oscillator1.frequency.setValueAtTime(880, audioContext.currentTime)
    oscillator1.frequency.exponentialRampToValueAtTime(1320, audioContext.currentTime + 0.08)

    oscillator2.frequency.setValueAtTime(1100, audioContext.currentTime + 0.04)
    oscillator2.frequency.exponentialRampToValueAtTime(1650, audioContext.currentTime + 0.12)

    gainNode.gain.setValueAtTime(0.15, audioContext.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15)

    oscillator1.start(audioContext.currentTime)
    oscillator2.start(audioContext.currentTime + 0.04)
    oscillator1.stop(audioContext.currentTime + 0.1)
    oscillator2.stop(audioContext.currentTime + 0.15)

    setTimeout(() => audioContext.close(), 200)
  } catch {}
}

export function playSpellSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioContext = new AudioContextClass()

    const metalOsc = audioContext.createOscillator()
    const metalGain = audioContext.createGain()
    const metalFilter = audioContext.createBiquadFilter()

    metalFilter.type = 'highpass'
    metalFilter.frequency.setValueAtTime(2000, audioContext.currentTime)

    metalOsc.type = 'square'
    metalOsc.frequency.setValueAtTime(800, audioContext.currentTime)
    metalOsc.frequency.exponentialRampToValueAtTime(1200, audioContext.currentTime + 0.05)
    metalOsc.frequency.exponentialRampToValueAtTime(600, audioContext.currentTime + 0.15)

    metalGain.gain.setValueAtTime(0.3, audioContext.currentTime)
    metalGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15)

    metalOsc.connect(metalFilter)
    metalFilter.connect(metalGain)
    metalGain.connect(audioContext.destination)

    metalOsc.start(audioContext.currentTime)
    metalOsc.stop(audioContext.currentTime + 0.15)

    const magicOsc1 = audioContext.createOscillator()
    const magicOsc2 = audioContext.createOscillator()
    const magicOsc3 = audioContext.createOscillator()
    const magicGain = audioContext.createGain()
    const magicFilter = audioContext.createBiquadFilter()

    magicFilter.type = 'lowpass'
    magicFilter.frequency.setValueAtTime(3000, audioContext.currentTime + 0.1)
    magicFilter.Q.setValueAtTime(5, audioContext.currentTime + 0.1)

    magicOsc1.type = 'sine'
    magicOsc1.frequency.setValueAtTime(400, audioContext.currentTime + 0.1)
    magicOsc1.frequency.exponentialRampToValueAtTime(800, audioContext.currentTime + 0.3)
    magicOsc1.frequency.exponentialRampToValueAtTime(200, audioContext.currentTime + 0.6)

    magicOsc2.type = 'sine'
    magicOsc2.frequency.setValueAtTime(600, audioContext.currentTime + 0.1)
    magicOsc2.frequency.exponentialRampToValueAtTime(1200, audioContext.currentTime + 0.25)
    magicOsc2.frequency.exponentialRampToValueAtTime(300, audioContext.currentTime + 0.6)

    magicOsc3.type = 'triangle'
    magicOsc3.frequency.setValueAtTime(1000, audioContext.currentTime + 0.1)
    magicOsc3.frequency.exponentialRampToValueAtTime(2000, audioContext.currentTime + 0.2)
    magicOsc3.frequency.exponentialRampToValueAtTime(100, audioContext.currentTime + 0.6)

    magicGain.gain.setValueAtTime(0, audioContext.currentTime)
    magicGain.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + 0.15)
    magicGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.6)

    magicOsc1.connect(magicFilter)
    magicOsc2.connect(magicFilter)
    magicOsc3.connect(magicFilter)
    magicFilter.connect(magicGain)
    magicGain.connect(audioContext.destination)

    magicOsc1.start(audioContext.currentTime + 0.1)
    magicOsc2.start(audioContext.currentTime + 0.1)
    magicOsc3.start(audioContext.currentTime + 0.1)
    magicOsc1.stop(audioContext.currentTime + 0.6)
    magicOsc2.stop(audioContext.currentTime + 0.6)
    magicOsc3.stop(audioContext.currentTime + 0.6)

    const sparkOsc = audioContext.createOscillator()
    const sparkGain = audioContext.createGain()

    sparkOsc.type = 'sine'
    sparkOsc.frequency.setValueAtTime(2000, audioContext.currentTime + 0.15)
    sparkOsc.frequency.exponentialRampToValueAtTime(4000, audioContext.currentTime + 0.25)
    sparkOsc.frequency.exponentialRampToValueAtTime(1500, audioContext.currentTime + 0.4)

    sparkGain.gain.setValueAtTime(0, audioContext.currentTime)
    sparkGain.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.15)
    sparkGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4)

    sparkOsc.connect(sparkGain)
    sparkGain.connect(audioContext.destination)

    sparkOsc.start(audioContext.currentTime + 0.15)
    sparkOsc.stop(audioContext.currentTime + 0.4)

    setTimeout(() => audioContext.close(), 700)
  } catch {}
}

export function playDotSelectSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioContext = new AudioContextClass()

    const osc1 = audioContext.createOscillator()
    const osc2 = audioContext.createOscillator()
    const gain = audioContext.createGain()

    osc1.connect(gain)
    osc2.connect(gain)
    gain.connect(audioContext.destination)

    osc1.type = 'sine'
    osc2.type = 'sine'

    osc1.frequency.setValueAtTime(1400, audioContext.currentTime)
    osc1.frequency.exponentialRampToValueAtTime(2100, audioContext.currentTime + 0.06)

    osc2.frequency.setValueAtTime(2800, audioContext.currentTime + 0.02)
    osc2.frequency.exponentialRampToValueAtTime(4200, audioContext.currentTime + 0.08)

    gain.gain.setValueAtTime(0.1, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.18)

    osc1.start(audioContext.currentTime)
    osc2.start(audioContext.currentTime + 0.02)
    osc1.stop(audioContext.currentTime + 0.18)
    osc2.stop(audioContext.currentTime + 0.18)

    setTimeout(() => audioContext.close(), 250)
  } catch {}
}

export function playDotRejectSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioContext = new AudioContextClass()

    const osc = audioContext.createOscillator()
    const gain = audioContext.createGain()

    osc.connect(gain)
    gain.connect(audioContext.destination)

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(220, audioContext.currentTime)
    osc.frequency.exponentialRampToValueAtTime(100, audioContext.currentTime + 0.14)

    gain.gain.setValueAtTime(0.06, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2)

    osc.start(audioContext.currentTime)
    osc.stop(audioContext.currentTime + 0.2)

    setTimeout(() => audioContext.close(), 250)
  } catch {}
}
