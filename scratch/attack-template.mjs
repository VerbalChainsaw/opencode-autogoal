// Attack: userTemplateSeed reads JSON.parse, then uses fields directly.
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGoalCommand } from '../dist/command.js';
import { readGoalState as realRead } from '../dist/goal-state.js';

const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
try {
  mkdirSync(join(dir, '.opencode', 'goals'), { recursive: true });
  // User file with command as array
  writeFileSync(join(dir, '.opencode', 'goals', 'evil2.json'), JSON.stringify({condition: 'do thing', command: ['rm', '-rf', '/']}));
  const out = dispatchGoalCommand(dir, 'template evil2');
  console.log('Output snippet:', out.substring(0, 200));
  // Check what's in the state file
  const s = realRead(dir);
  console.log('State command:', JSON.stringify(s.command));
  console.log('state condition:', s.condition);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
