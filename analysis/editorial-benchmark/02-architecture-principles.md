# Editorial principles distilled from the three-video benchmark (lead-architect note)

Evidence: `01-three-video-analysis.json`. The source timestamps here are only benchmark
evidence. They must never appear in production code.

## What the human edit actually did
- The dense coverage is one continuous incident window, about the first 2 minutes of a 28.7-minute
  source. Two later shots appear only as picture under narration: a time-compression bridge and a
  cliffhanger tease. They never play as their own dialogue beats.
- Content from outside the window (later interviews, background) is carried by narration
  sentences over in-window footage. The editor does not cut to it.
- The cold open is a flash-forward from inside the same window, only a few seconds ahead. It holds
  back the key visual reveal. The rewind replays part of the hook in context and skips what the
  viewer has already seen.
- The ending names a specific consequence of the central conflict and withholds it
  (forward cliffhanger). It does not reach into a different branch of the source.

## What AutoStory did
- It treated the whole 28.7-minute source as one pool of interesting beats. It made five jumps of
  3 to 10 minutes with no causal bridge, and 61% of the runtime was after-the-fact interviews.
- The hook showed the reveal outright.
- Several beats did not contain what the text plan claimed. Beats were chosen from text metadata
  without watching the footage.
- The ending is a transition fragment, not a consequence of the opening conflict.

## Generic principles (encoded as contracts, NOT heuristics)
1. **Scope before footage.** Before choosing any exact range, pick one mini-story: a central
   conflict, one viewer question, a causal spine, and an explicit boundary. The EDL is built inside
   that scope.
2. **Novel AND causally coherent.** Every beat must change what the viewer knows about the central
   question, and follow causally from the previous beat. A new timestamp, speaker, fact or piece of
   evidence does not count as progress on its own.
3. **Out-of-scope material is compressed, not visited.** If the story needs a fact that lives
   outside the scope (a later interview, background), a narration line delivers it over in-scope
   picture. A later clip is cut to only when the scope's causal spine includes it.
4. **Hook = a mini-arc drawn from inside the scope** that stops before the payoff. After the
   rewind, the question is still open.
5. **Ending = a consequence of the central conflict.** It is either a payoff or an explicitly
   promised forward cliffhanger drawn from the scope's candidate endings.
6. **Media grounds the choice.** The model that picks exact ranges must see the footage it picks,
   so a claimed "escalation" is visually real.
7. **One timeline owner.** Downstream code validates. It does not re-rank, reorder, inject or
   extend story material.

## Architectural consequences
- A first-class `StoryScope` contract and a Gemini scope-selection pass over the Source Story
  Model.
- A scope-bounded media reel with a manifest back to absolute source time, fed to the Editorial
  Director.
- A scope-membership check on the final EDL: each beat's source range must intersect a scope
  window, or be declared narration picture for a bridge or tease. This is a deterministic
  validation of Gemini's own declared scope. It does not score story quality.
- On the explicit media-grounded path, RetentionArc, BeatCoverage and DurationFit are
  validator-only. A duration failure goes back to Gemini.
- The critic reports scope survival and causal breaks. Repair receives the scope, the EDL, the
  weak region and the scope media.
