// custom_glitch.js — ffglitch scripting for residual destruction and motion vector hacks (MPEG-2 edition)
//
// Mode values:
// 2 = Residual Destruct (zeros out DCT coefficients to force pixel bleeding)
// 3 = Motion Vector Hack (multiplies or shifts motion vectors)
//
// Parameters passed from Python via -sp:
// [mode, start_frame, end_frame, multiplier_percent, drift_h, drift_v]

let mode = 0;
let start_frame = 0;
let end_frame = 999999;
let multiplier = 1.0;
let drift_h = 0;
let drift_v = 0;
let frame_index = 0;

export function setup(args) {
  if ( "params" in args ) {
    const p = args.params;
    if ( p.length > 0 ) mode = p[0];
    if ( p.length > 1 ) start_frame = p[1];
    if ( p.length > 2 ) end_frame = p[2];
    if ( p.length > 3 ) multiplier = p[3] / 100.0;
    if ( p.length > 4 ) drift_h = p[4];
    if ( p.length > 5 ) drift_v = p[5];
  }

  // Request ONLY the required feature to prevent ffedit mutual exclusivity errors
  if ( mode === 2 ) {
    args.features = [ "q_dct" ];
  } else {
    args.features = [ "mv" ];
  }
}

export function glitch_frame(frame) {
  const current_frame = (typeof frame.number === "number") ? frame.number : frame_index;
  frame_index++;

  // Apply glitch only if current frame is in the specified range
  if ( current_frame >= start_frame && current_frame <= end_frame ) {
    
    if ( mode === 2 ) {
      // Clear residuals (zeros out DCT coefficients to prevent reconstruction)
      if ( frame.q_dct && frame.q_dct.data ) {
        const planes = frame.q_dct.data;
        for ( let p = 0; p < planes.length; p++ ) {
          const plane = planes[p];
          for ( let r = 0; r < plane.length; r++ ) {
            const row = plane[r];
            for ( let c = 0; c < row.length; c++ ) {
              const block = row[c];
              if ( block ) {
                for ( let i = 0; i < block.length; i++ ) {
                  block[i] = 0;
                }
              }
            }
          }
        }
      }
    } 
    
    if ( mode === 3 ) {
      // Modify motion vectors
      const fwd = frame.mv?.forward;
      if ( fwd ) {
        frame.mv.overflow = "truncate";
        if ( multiplier !== 1.0 ) {
          fwd.mul(MV(multiplier, multiplier));
        }
        if ( drift_h !== 0 || drift_v !== 0 ) {
          fwd.add_h(drift_h);
          fwd.add_v(drift_v);
        }
      }
    }
  }
}
