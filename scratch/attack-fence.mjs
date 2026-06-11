import { detectMarker, COMPLETE_RE, BLOCKED_RE } from '../dist/goal-state.js';

// Confirm: 4-backtick fence, 3-backtick on its own line closes it
const text = '````python\nsome code\n```\nGOAL_COMPLETE: a\n````';
console.log('Result:', JSON.stringify(detectMarker(text, COMPLETE_RE)));
// The 3-backtick on its own line closes the 4-backtick outer fence
// Trace:
// Line 1: '````python' → FENCE_RE matches (4 backticks), marker=`
//   inFence was false → inFence=true, fenceMarker=` (only first char considered)
// Line 2: 'some code' → not fence, in fence, skip
// Line 3: '```' → FENCE_RE matches (3 backticks), marker=`
//   inFence=true, fenceMarker=`, close it: inFence=false
// Line 4: 'GOAL_COMPLETE: a' → not fence, NOT in fence, MATCHES COMPLETE_RE
// Line 5: '````' → opens new fence, but it's the last line, never closed
console.log('Confirmed: the 3-backtick line closes the 4-backtick fence prematurely');
