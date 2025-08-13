import {createServer, Server, Socket} from "net";
import {createInterface} from "readline";
import { Command } from "../commands/CommandHandler";
import * as minimist from "minimist";

/**
 * Formats a structured response for CLI display
 */
function formatResponseForCli(response: any): string {
    if (typeof response === 'string') {
        return response;
    }
    
    if (typeof response === 'object' && response !== null) {
        // For objects, create a human-readable format
        return JSON.stringify(response, null, 2);
    }
    
    return String(response);
}

export interface TcpCliConfig {
    address: string;
    port: number;
    introMessage: string;
}

export class TcpCliServer {
    private server: Server | null = null;
    private commands: { [key: string]: Command<any> };
    private config: TcpCliConfig;

    constructor(commands: { [key: string]: Command<any> }, config: TcpCliConfig) {
        this.commands = commands;
        this.config = config;
    }

    async start(): Promise<void> {
        if (this.server) {
            throw new Error('TcpCliServer: Server already started');
        }

        this.server = createServer((socket) => {
            socket.write(this.config.introMessage + "\n");
            socket.write("Type 'help' to get a summary of existing commands!\n> ");

            const rl = createInterface({input: socket});
            rl.on("line", (line) => {
                this.parseLine(line, socket).then(result => {
                    socket.write(result + "\n> ");
                }).catch(err => {
                    console.error(err);
                    socket.write("Error: " + (err.message != null ? err.message : JSON.stringify(err)) + "\n> ");
                });
            });

            socket.on("error", (err) => {
                console.error("TcpCliServer: Socket error: ", err);
            });
        });

        return new Promise<void>((resolve, reject) => {
            this.server!.listen(this.config.port, this.config.address, () => {
                console.log(`TcpCliServer: TCP CLI server listening on ${this.config.address}:${this.config.port}`);
                resolve();
            });

            this.server!.on('error', (error: any) => {
                console.error('TcpCliServer: Server error:', error);
                reject(error);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }

        return new Promise<void>((resolve) => {
            this.server!.close(() => {
                console.log('TcpCliServer: Server stopped');
                this.server = null;
                resolve();
            });
        });
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    private getUsageString(cmd: Command<any>): string {
        const args = [];
        for(let key in cmd.runtime.args) {
            if (cmd.runtime.args[key].base) {
                args.push("<"+key+">");
            }
        }
        return cmd.cmd+" "+args.join(" ");
    }

    private getParamsDescription(cmd: Command<any>): string[] {
        const params = [];
        for(let key in cmd.runtime.args) {
            params.push("--"+key+" : "+cmd.runtime.args[key].description);
        }
        return params;
    }

    private getCommandHelp(cmd: Command<any>): string {
        const lines = [
            "Command: "+cmd.cmd,
            "Description: "+cmd.description,
            "Usage: "+this.getUsageString(cmd)
        ];

        const paramLines = this.getParamsDescription(cmd);
        if(paramLines.length!==0) lines.push("Params:");
        paramLines.forEach(param => {
            lines.push("    "+param);
        });

        return lines.join("\n");
    }

    private getHelp(): string {
        const lines = ["Available commands:"];
        for(let key in this.commands) {
            lines.push("    "+key+" : "+this.commands[key].description);
        }
        lines.push("Use 'help <command name>' for usage examples, description & help around a specific command!");
        return lines.join("\n");
    }

    private parseLine(line: string, socket: Socket): Promise<string> {
        if(line==="") return Promise.resolve("");
        const regex = new RegExp('"[^"]+"|[\\S]+', 'g');
        const args = [];
        line.match(regex).forEach(element => {
            if (!element) return;
            return args.push(element.replace(/"/g, ''));
        });

        if(args[0]==="help") {
            if(args[1]!=null && this.commands[args[1]]!=null) {
                return Promise.resolve(this.getCommandHelp(this.commands[args[1]]));
            }
            return Promise.resolve(this.getHelp());
        }

        const cmd = this.commands[args[0]];

        if(cmd==null) {
            return Promise.resolve("Error: Unknown command, please type 'help' to get a list of all commands!");
        }

        const result = minimist(args, {string: ["_"].concat(Object.keys(cmd.runtime.args))}); //Treat all keys as string

        const paramsObj: any = {};

        let index = 1;
        for(let key in cmd.runtime.args) {
            if(cmd.runtime.args[key].base) {
                if(result[key]==null && result._[index]!=null) result[key] = result._[index];
                index++;
            }
            try {
                paramsObj[key] = cmd.runtime.args[key].parser(result[key]);
            } catch (e) {
                return Promise.resolve("Error: Parsing parameter '"+key+"': "+e.message+"\n\n"+this.getCommandHelp(cmd));
            }
        }

        return cmd.runtime.parser(paramsObj, (line: string) => socket.write(line+"\n")).then(commandResult => {
            return formatResponseForCli(commandResult);
        });
    }
}
