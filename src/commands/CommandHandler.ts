import { JsonRpcServer, RpcConfig } from "../rpc/JsonRpcServer";
import { TcpCliServer, TcpCliConfig } from "../tcp-cli/TcpCliServer";

export type ParamParser<T> = (data: string) => T;

export type ArgsTemplate<T extends { [key: string]: any }> = {
    [key in keyof T]: {
        base?: boolean,
        description: string,
        parser: ParamParser<T[key]>
    }
};

export type ParsedArgs<V, T extends ArgsTemplate<V>> = {
    [key in keyof T]: ReturnType<T[key]["parser"]>
};

export type CommandRuntime<T extends { [key: string]: any }> = {
    args: ArgsTemplate<T>,
    parser: (args: ParsedArgs<T, ArgsTemplate<T>>, sendLine: (line: string) => void) => Promise<any>
}

export type Command<T extends { [key: string]: any }> = {
    cmd: string,
    description: string,
    runtime: CommandRuntime<T>
};

export const cmdNumberParser: (decimal: boolean, min?: number, max?: number, optional?: boolean) => ParamParser<number>  = (decimal: boolean, min?: number, max?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: number = decimal ? parseFloat(data) : parseInt(data);
    if(num==null || isNaN(num)) throw new Error("Number is NaN or null");
    if(min!=null && num<min) throw new Error("Number must be greater than "+min);
    if(max!=null && num>max) throw new Error("Number must be less than "+max);
    return num;
};

export const cmdBigIntParser: (min?: bigint, max?: bigint, optional?: boolean) => ParamParser<bigint>  = (min?: bigint, max?: bigint, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: bigint = BigInt(data);
    if(num==null) throw new Error("Number is NaN or null");
    if(min!=null && num < min) throw new Error("Number must be greater than "+min.toString(10));
    if(max!=null && num > max) throw new Error("Number must be less than "+max.toString(10));
    return num;
};

export function cmdEnumParser<T extends string>(possibleValues: T[], optional?: boolean): ParamParser<T> {
    const set = new Set(possibleValues);
    return (data: string) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(!set.has(data as T)) throw new Error("Invalid enum value, possible values: "+possibleValues.join(", "));
        return data as T;
    };
};

export const cmdStringParser: (minLength?: number, maxLength?: number, optional?: boolean) => ParamParser<string> = (minLength?: number, maxLength?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(minLength!=null && data.length<minLength) throw new Error("Invalid string length, min length: "+minLength);
    if(maxLength!=null && data.length>maxLength) throw new Error("Invalid string length, max length: "+maxLength);
    return data;
};

export function createCommand<T extends { [key: string]: any }>(cmd: string, description: string, runtime: CommandRuntime<T>): Command<T> {
    return { cmd, description, runtime };
}


export class CommandHandler {

    tcpCliServer?: TcpCliServer;
    rpcServer?: JsonRpcServer;

    readonly commands: {
        [key: string]: Command<any>
    };
    readonly tcpCliConfig?: TcpCliConfig;
    readonly rpcConfig?: RpcConfig;

    constructor(
        commands: Command<any>[],
        tcpCliConfig?: TcpCliConfig,
        rpcConfig?: RpcConfig
    ) {
        this.commands = {};
        commands.forEach(cmd => {
            this.commands[cmd.cmd] = cmd;
        });
        this.tcpCliConfig = tcpCliConfig;
        this.rpcConfig = rpcConfig;
    }

    registerCommand(cmd: Command<any>): boolean {
        if(this.commands[cmd.cmd]!=null) return false;
        this.commands[cmd.cmd] = cmd;
        
        // Both RPC and TCP CLI servers hold a reference to this.commands, so they will automatically see the new command
        
        return true;
    }

    async init() {
        // Start TCP CLI server if configured
        if (this.tcpCliConfig) {
            try {
                this.tcpCliServer = new TcpCliServer(this.commands, this.tcpCliConfig);
                await this.tcpCliServer.start();
            } catch (error) {
                console.error("CommandHandler: Failed to start TCP CLI server:", error);
                throw error;
            }
        }

        // Start RPC server if configured
        if (this.rpcConfig) {
            try {
                this.rpcServer = new JsonRpcServer(this.commands, this.rpcConfig);
                await this.rpcServer.start();
            } catch (error) {
                console.error("CommandHandler: Failed to start JSON-RPC server:", error);
                throw error;
            }
        }
    }

    async stop(): Promise<void> {
        const promises: Promise<void>[] = [];

        if (this.tcpCliServer?.isRunning()) {
            promises.push(this.tcpCliServer.stop());
        }

        if (this.rpcServer?.isRunning()) {
            promises.push(this.rpcServer.stop());
        }

        await Promise.all(promises);
    }

    isRunning(): boolean {
        return (this.tcpCliServer?.isRunning() || false) || (this.rpcServer?.isRunning() || false);
    }

}