/**
 * Key Signatures & FL Studio Piano Roll Melodic Chords Reference Data
 * Extracted from FL Studio 2026 build 26.1.1.5547 Stamp Presets & Circle of Fifths
 */

export const KEY_SIGNATURES_DATA = {
  "keys": [
    {
      "major": "C Major",
      "minor": "A Minor",
      "acc": "Natural (0)",
      "sharps": 0,
      "flats": 0,
      "notes": "C D E F G A B",
      "camelotMaj": "8B",
      "camelotMin": "8A"
    },
    {
      "major": "G Major",
      "minor": "E Minor",
      "acc": "1# (F#)",
      "sharps": 1,
      "flats": 0,
      "notes": "G A B C D E F#",
      "camelotMaj": "9B",
      "camelotMin": "9A"
    },
    {
      "major": "D Major",
      "minor": "B Minor",
      "acc": "2# (F#, C#)",
      "sharps": 2,
      "flats": 0,
      "notes": "D E F# G A B C#",
      "camelotMaj": "10B",
      "camelotMin": "10A"
    },
    {
      "major": "A Major",
      "minor": "F# Minor",
      "acc": "3# (F#, C#, G#)",
      "sharps": 3,
      "flats": 0,
      "notes": "A B C# D E F# G#",
      "camelotMaj": "11B",
      "camelotMin": "11A"
    },
    {
      "major": "E Major",
      "minor": "C# Minor",
      "acc": "4# (F#, C#, G#, D#)",
      "sharps": 4,
      "flats": 0,
      "notes": "E F# G# A B C# D#",
      "camelotMaj": "12B",
      "camelotMin": "12A"
    },
    {
      "major": "B Major",
      "minor": "G# Minor",
      "acc": "5# (F#, C#, G#, D#, A#)",
      "sharps": 5,
      "flats": 0,
      "notes": "B C# D# E F# G# A#",
      "camelotMaj": "1B",
      "camelotMin": "1A"
    },
    {
      "major": "F# Major",
      "minor": "D# Minor",
      "acc": "6# (F#, C#, G#, D#, A#, E#)",
      "sharps": 6,
      "flats": 0,
      "notes": "F# G# A# B C# D# E#",
      "camelotMaj": "2B",
      "camelotMin": "2A"
    },
    {
      "major": "C# Major",
      "minor": "A# Minor",
      "acc": "7# (F#, C#, G#, D#, A#, E#, B#)",
      "sharps": 7,
      "flats": 0,
      "notes": "C# D# E# F# G# A# B#",
      "camelotMaj": "3B",
      "camelotMin": "3A"
    },
    {
      "major": "F Major",
      "minor": "D Minor",
      "acc": "1b (Bb)",
      "sharps": 0,
      "flats": 1,
      "notes": "F G A Bb C D E",
      "camelotMaj": "7B",
      "camelotMin": "7A"
    },
    {
      "major": "Bb Major",
      "minor": "G Minor",
      "acc": "2b (Bb, Eb)",
      "sharps": 0,
      "flats": 2,
      "notes": "Bb C D Eb F G A",
      "camelotMaj": "6B",
      "camelotMin": "6A"
    },
    {
      "major": "Eb Major",
      "minor": "C Minor",
      "acc": "3b (Bb, Eb, Ab)",
      "sharps": 0,
      "flats": 3,
      "notes": "Eb F G Ab Bb C D",
      "camelotMaj": "5B",
      "camelotMin": "5A"
    },
    {
      "major": "Ab Major",
      "minor": "F Minor",
      "acc": "4b (Bb, Eb, Ab, Db)",
      "sharps": 0,
      "flats": 4,
      "notes": "Ab Bb C Db Eb F G",
      "camelotMaj": "4B",
      "camelotMin": "4A"
    },
    {
      "major": "Db Major",
      "minor": "Bb Minor",
      "acc": "5b (Bb, Eb, Ab, Db, Gb)",
      "sharps": 0,
      "flats": 5,
      "notes": "Db Eb F Gb Ab Bb C",
      "camelotMaj": "3B",
      "camelotMin": "3A"
    },
    {
      "major": "Gb Major",
      "minor": "Eb Minor",
      "acc": "6b (Bb, Eb, Ab, Db, Gb, Cb)",
      "sharps": 0,
      "flats": 6,
      "notes": "Gb Ab Bb Cb Db Eb F",
      "camelotMaj": "2B",
      "camelotMin": "2A"
    },
    {
      "major": "Cb Major",
      "minor": "Ab Minor",
      "acc": "7b (Bb, Eb, Ab, Db, Gb, Cb, Fb)",
      "sharps": 0,
      "flats": 7,
      "notes": "Cb Db Eb Fb Gb Ab Bb",
      "camelotMaj": "1B",
      "camelotMin": "1A"
    }
  ],
  "chords": [
    {
      "name": "Major",
      "formula": "1 - 3 - 5",
      "semitones": [
        0,
        4,
        7
      ],
      "c_notes": "C - E - G",
      "desc": "Standard major triad"
    },
    {
      "name": "Minor",
      "formula": "1 - b3 - 5",
      "semitones": [
        0,
        3,
        7
      ],
      "c_notes": "C - Eb - G",
      "desc": "Standard minor triad"
    },
    {
      "name": "Fifth",
      "formula": "1 - 5",
      "semitones": [
        0,
        7
      ],
      "c_notes": "C - G",
      "desc": "Power chord (dyad)"
    },
    {
      "name": "Fifth 9th",
      "formula": "1 - 5 - 9",
      "semitones": [
        0,
        7,
        14
      ],
      "c_notes": "C - G - D",
      "desc": "Stacked fifth and ninth"
    },
    {
      "name": "Fifth Octave",
      "formula": "1 - 5 - 8",
      "semitones": [
        0,
        7,
        12
      ],
      "c_notes": "C - G - C",
      "desc": "Power chord with root octave"
    },
    {
      "name": "Major 7th",
      "formula": "1 - 3 - 5 - 7",
      "semitones": [
        0,
        4,
        7,
        11
      ],
      "c_notes": "C - E - G - B",
      "desc": "Lush jazz / neo-soul major 7th"
    },
    {
      "name": "Minor 7th",
      "formula": "1 - b3 - 5 - b7",
      "semitones": [
        0,
        3,
        7,
        10
      ],
      "c_notes": "C - Eb - G - Bb",
      "desc": "Standard minor 7th"
    },
    {
      "name": "Minor 9th",
      "formula": "1 - b3 - 5 - b7 - 9",
      "semitones": [
        0,
        3,
        7,
        10,
        14
      ],
      "c_notes": "C - Eb - G - Bb - D",
      "desc": "Extended 5-note minor 9th"
    },
    {
      "name": "Suspended 2",
      "formula": "1 - 2 - 5",
      "semitones": [
        0,
        2,
        7
      ],
      "c_notes": "C - D - G",
      "desc": "Sus2 (major second replaces third)"
    },
    {
      "name": "Suspended 4",
      "formula": "1 - 4 - 5",
      "semitones": [
        0,
        5,
        7
      ],
      "c_notes": "C - F - G",
      "desc": "Sus4 (perfect fourth replaces third)"
    },
    {
      "name": "Augmented",
      "formula": "1 - 3 - #5",
      "semitones": [
        0,
        4,
        8
      ],
      "c_notes": "C - E - G#",
      "desc": "Symmetrical augmented triad"
    },
    {
      "name": "Diminished",
      "formula": "1 - b3 - b5",
      "semitones": [
        0,
        3,
        6
      ],
      "c_notes": "C - Eb - Gb",
      "desc": "Tritone-bearing diminished triad"
    },
    {
      "name": "Octave",
      "formula": "1 - 8",
      "semitones": [
        0,
        12
      ],
      "c_notes": "C - C",
      "desc": "Unison octave double"
    }
  ],
  "advanced": [
    {
      "name": "7 (Dominant)",
      "formula": "1 - 3 - 5 - b7",
      "semitones": [
        0,
        4,
        7,
        10
      ],
      "c_notes": "C - E - G - Bb",
      "desc": "Blues & funk dominant 7th"
    },
    {
      "name": "7#9 (Hendrix)",
      "formula": "1 - 3 - 5 - b7 - #9",
      "semitones": [
        0,
        4,
        7,
        10,
        15
      ],
      "c_notes": "C - E - G - Bb - D#",
      "desc": "Psychedelic altered dominant"
    },
    {
      "name": "9 (Dominant 9)",
      "formula": "1 - 3 - 5 - b7 - 9",
      "semitones": [
        0,
        4,
        7,
        10,
        14
      ],
      "c_notes": "C - E - G - Bb - D",
      "desc": "Smooth dominant 9th"
    },
    {
      "name": "Maj9",
      "formula": "1 - 3 - 5 - 7 - 9",
      "semitones": [
        0,
        4,
        7,
        11,
        14
      ],
      "c_notes": "C - E - G - B - D",
      "desc": "Dreamy major 9th"
    },
    {
      "name": "m7b5",
      "formula": "1 - b3 - b5 - b7",
      "semitones": [
        0,
        3,
        6,
        10
      ],
      "c_notes": "C - Eb - Gb - Bb",
      "desc": "Half-diminished ii chord"
    },
    {
      "name": "tri (Dim 7)",
      "formula": "1 - b3 - b5 - bb7",
      "semitones": [
        0,
        3,
        6,
        9
      ],
      "c_notes": "C - Eb - Gb - A",
      "desc": "Fully diminished 7th"
    },
    {
      "name": "6add9",
      "formula": "1 - 3 - 5 - 6 - 9",
      "semitones": [
        0,
        4,
        7,
        9,
        14
      ],
      "c_notes": "C - E - G - A - D",
      "desc": "Bossa nova & jazz tonic chord"
    },
    {
      "name": "m11",
      "formula": "1 - b3 - 5 - b7 - 9 - 11",
      "semitones": [
        0,
        3,
        7,
        10,
        14,
        17
      ],
      "c_notes": "C - Eb - G - Bb - D - F",
      "desc": "11th extended chord"
    }
  ]
};
