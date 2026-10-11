import { buildProgram } from './cli/program.js';

await buildProgram().parseAsync(process.argv);
