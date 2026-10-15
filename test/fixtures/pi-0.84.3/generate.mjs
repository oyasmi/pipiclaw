import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const installation = process.argv[2];
if (!installation)
    throw new Error('Pass an isolated npm installation containing pi 0.84.3.');
const sdk = join(installation, 'node_modules/@earendil-works/pi-coding-agent');
if (JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version !== '0.84.3')
    throw new Error('Fixture generation requires exact pi 0.84.3.');
const { SessionManager } = await import(pathToFileURL(join(sdk, 'dist/index.js')).href);
const root = fileURLToPath(new URL('.', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pi055-fixtures-'));
const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'fixture reasoning' }, { type: 'text', text }], api: 'openai-completions', provider: 'e2e-mock', model: 'mock-main', stopReason, usage, timestamp: 1, ...(stopReason === 'error' ? { errorMessage: '429 fixture' } : {}) });
for (const name of ['chat', 'branch', 'task', 'interrupted', 'azure']) {
    const path = `${scratch}/${name}.jsonl`;
    const s = SessionManager.open(path);
    s.appendModelChange(name === 'azure' ? 'azure-openai-responses' : 'e2e-mock', name === 'azure' ? 'fixture-deployment' : 'mock-main');
    s.appendThinkingLevelChange('medium');
    const first = s.appendMessage({ role: 'user', content: 'OLD_HISTORY', timestamp: 1 });
    s.appendMessage(assistant('OLD_ANSWER'));
    if (name === 'branch') {
        const kept = s.appendMessage({ role: 'user', content: 'KEPT_HISTORY', timestamp: 1 });
        s.appendMessage(assistant('KEPT_ANSWER'));
        s.appendCompaction('FIXTURE_SUMMARY', kept, 12000);
        const fork = s.appendMessage({ role: 'user', content: 'DISCARDED_BRANCH', timestamp: 1 });
        s.appendMessage(assistant('DISCARDED_ANSWER'));
        s.branch(fork);
        s.appendMessage(assistant('BRANCH_ANSWER'));
    }
    if (name === 'task') {
        s.appendMessage({ ...assistant(''), content: [{ type: 'toolCall', id: 'fixture-tool', name: 'read', arguments: { path: 'fixture.txt' } }], stopReason: 'toolUse' });
        s.appendMessage({ role: 'toolResult', toolCallId: 'fixture-tool', toolName: 'read', content: [{ type: 'text', text: 'TASK_TOOL_RESULT' }], isError: false, timestamp: 1 });
        s.appendMessage(assistant('TASK_HISTORY'));
    }
    if (name === 'interrupted') {
        s.appendMessage({ role: 'user', content: 'INTERRUPTED_INPUT', timestamp: 1 });
        s.appendMessage(assistant('', 'error'));
    }
    if (name === 'branch') {
        const fork = s.createBranchedSession(s.getLeafId());
        writeFileSync(`${scratch}/fork.jsonl`, readFileSync(fork));
    }
    let lines = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    let i = 0;
    const ids = new Map(lines.filter(x => x.id).map(x => [x.id, x.type === 'session' ? '05500000-0000-4000-8000-000000000001' : `055${String(++i).padStart(5, '0')}`]));
    lines = lines.map(x => ({ ...x, ...(x.id ? { id: ids.get(x.id) } : {}), ...(x.parentId ? { parentId: ids.get(x.parentId) } : {}), ...(x.firstKeptEntryId ? { firstKeptEntryId: ids.get(x.firstKeptEntryId) } : {}), timestamp: '2026-01-01T00:00:00.000Z', ...(x.cwd ? { cwd: '/fixture/workspace' } : {}) }));
    writeFileSync(`${root}/${name}.jsonl`, lines.map(JSON.stringify).join('\n') + '\n');
}
const forkLines = readFileSync(`${scratch}/fork.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
let index = 0;
const forkIds = new Map(forkLines.filter(x => x.id).map(x => [x.id, x.type === 'session' ? '05500000-0000-4000-8000-000000000002' : `055${String(++index).padStart(5, '0')}`]));
writeFileSync(`${root}/fork.jsonl`, forkLines.map(x => JSON.stringify({ ...x, ...(x.id ? { id: forkIds.get(x.id) } : {}), ...(x.parentId ? { parentId: forkIds.get(x.parentId) } : {}), ...(x.firstKeptEntryId ? { firstKeptEntryId: forkIds.get(x.firstKeptEntryId) } : {}), timestamp: '2026-01-01T00:00:00.000Z', ...(x.cwd ? { cwd: '/fixture/workspace' } : {}), ...(x.parentSession ? { parentSession: '/fixture/branch.jsonl' } : {}) })).join('\n') + '\n');
rmSync(scratch, { recursive: true, force: true });
