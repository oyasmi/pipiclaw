/** A fixture-owned release replaces wall-clock sleeps; completion happens after the tested turn. */
export function controlledProducer(releasePath: string, value: string, outputPath?: string): string {
	return `import {existsSync,watch,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
const release=${JSON.stringify(releasePath)},value=${JSON.stringify(value)},output=${JSON.stringify(outputPath ?? null)};
let finished=false;
const finish=()=>{if(finished||!existsSync(release))return;finished=true;watcher.close();if(output)writeFileSync(output,value+'\\n');else process.stdout.write(value+'\\n');};
const watcher=watch(dirname(release),finish);finish();\n`;
}
