// melt.js — ffglitch motion-vector "melt" glitch
//
// What it does: dampens horizontal motion so vertical motion dominates
// (a "sink/rise" bias), then keeps a rolling average of each macroblock's
// motion vector over the last N frames. Because old motion keeps bleeding
// into new frames instead of resetting every frame, image content trails
// and drips downward instead of updating cleanly -- the "melt" look.
//
// Run directly with ffedit:
//   ffedit -i prepped.m4v -s melt.js -o glitched.m4v -y
//
// Override the three tunables below from the command line instead of
// editing the file, as a JSON array [tail_length, h_damp_percent, v_drift].
// NOTE: ffedit's -sp parser only accepts integers (no decimals), so
// h_damp is passed as a whole-number percent (0-100) here, not a fraction:
//   ffedit -i prepped.m4v -s melt.js -sp "[24, 10, 2]" -o glitched.m4v -y

/*********************************************************************/
// TWEAK THESE
let tail_length = 18;    // frames of "memory" in the smear. Higher = longer, gooier drips. Try 8-40.
let h_damp      = 0.15;  // 0..1, fraction of horizontal motion kept each frame. Lower = flatter, more vertical streaking. 1 = no dampening.
let v_drift     = 1;     // constant per-frame vertical push added to the smear. If it climbs instead of drips, flip the sign.

/*********************************************************************/
let history = [];
let running_sum;

export function setup(args)
{
  // we only need motion vectors for this glitch
  args.features = [ "mv" ];

  if ( "params" in args )
  {
    const p = args.params;
    if ( p.length > 0 ) tail_length = p[0];
    if ( p.length > 1 ) h_damp      = p[1] / 100; // whole-number percent -> fraction
    if ( p.length > 2 ) v_drift     = p[2];
  }
}

export function glitch_frame(frame)
{
  const fwd = frame.mv?.forward;
  // bail out on frames with no forward motion vectors (e.g. a lone I-frame)
  if ( !fwd )
    return;

  // accumulating/damping vectors will regularly push values outside the
  // codec's native mv range -- tell ffedit to clamp instead of throwing
  frame.mv.overflow = "truncate";

  // squash horizontal motion so the drift reads as vertical "sinking"
  // rather than a generic sideways smear
  fwd.mul_h(h_damp);

  // this frame's (already-damped) vectors, plus a constant downward nudge
  const clean = fwd.dup();
  clean.add_v(v_drift);

  if ( !running_sum )
    running_sum = new MV2DArray(fwd.width, fwd.height);

  history.push(clean);
  running_sum.add(clean);
  if ( history.length > tail_length )
  {
    running_sum.sub(history[0]);
    history = history.slice(1);
  }

  // replace this frame's vectors with the running average of the last
  // `tail_length` frames -- this is what makes old motion bleed forward
  fwd.assign(running_sum);
  fwd.div(MV(history.length, history.length));
}
