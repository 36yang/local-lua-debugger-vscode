/** @noSelfInFile */

interface Var {
    val: unknown;
    type: string;
}

interface Vars {
    [name: string]: Var;
}

interface Local extends Var {
    index: number;
}

interface Locals {
    [name: string]: Local;
}

namespace Breakpoint {
    let current: Breakpoint[] = [];

    export function get(file: string, line: number): Breakpoint | undefined {
        for (const [_, breakpoint] of ipairs(current)) {
            if (breakpoint.file === file && breakpoint.line === line) {
                return breakpoint;
            }
        }
        return undefined;
    }

    export function getAll(): Breakpoint[] {
        return current;
    }

    function makeFilePattern(file: string) {
        file = Format.path(file);
        [file] = file.gsub("%.", "%.");
        file = file + "$";
        return file;
    }

    export function add(file: string, line: number) {
        const pattern = makeFilePattern(file);
        table.insert(current, {file, line, pattern, enabled: true});
    }

    export function remove(file: string, line: number) {
        for (const [i, breakpoint] of ipairs(current)) {
            if (breakpoint.file === file && breakpoint.line === line) {
                table.remove(current, i);
                break;
            }
        }
    }

    export function clear() {
        current = [];
    }
}

interface SourceMap {
    [line: number]: {
        sourceIndex: number;
        sourceLine: number;
    };
    sources: string[];
}

namespace SourceMap
{
    const cache: { [file: string]: SourceMap | false | undefined } = {};

    const base64Lookup: { [char: string]: number } = {
        A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7,
        I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, P: 15,
        Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23,
        Y: 24, Z: 25, a: 26, b: 27, c: 28, d: 29, e: 30, f: 31,
        g: 32, h: 33, i: 34, j: 35, k: 36, l: 37, m: 38, n: 39,
        o: 40, p: 41, q: 42, r: 43, s: 44, t: 45, u: 46, v: 47,
        w: 48, x: 49, y: 50, z: 51, 0: 52, 1: 53, 2: 54, 3: 55,
        4: 56, 5: 57, 6: 58, 7: 59, 8: 60, 9: 61, "+": 62, "/": 63,
        "=": 0
    };

    function base64Decode(input: string) {
        const results: string[] = [];
        const bits: boolean[] = [];
        for (const [c] of input.gmatch(".")) {
            let sextet = assert(base64Lookup[c]);
            for (let i = 0; i < 6; ++i) {
                const bit = sextet % 2 !== 0;
                table.insert(bits, i + 1, bit);
                sextet = math.floor(sextet / 2);
            }
            if (bits.length >= 8) {
                let value = 0;
                for (let i = 7; i >= 0; --i) {
                    const bit = table.remove(bits);
                    if (bit === true) {
                        value += (2 ** i);
                    }
                }
                table.insert(results, string.char(value));
            }
        }
        return table.concat(results);
    }

    function decodeBase64VLQ(input: string) {
        const values: number[] = [];
        let bits: boolean[] = [];
        for (const [c] of input.gmatch(".")) {
            let sextet = assert(base64Lookup[c]);
            for (let i = 0; i < 5; ++i) {
                const bit = sextet % 2 !== 0;
                table.insert(bits, bit);
                sextet = math.floor(sextet / 2);
            }
            const continueBit = sextet % 2 !== 0;
            if (!continueBit) {
                let value = 0;
                for (let i = 1; i < bits.length; ++i) {
                    if (bits[i]) {
                        value += (2 ** (i - 1));
                    }
                }
                if (bits[0]) {
                    value = -value;
                }
                table.insert(values, value);
                bits = [];
            }
        }
        return values;
    }

    function build(data: string) {
        const [sources] = data.match('"sources"%s*:%s*(%b[])');
        const [mappings] = data.match('"mappings"%s*:%s*"([^"]+)"');
        if (mappings === undefined || sources === undefined) {
            return undefined;
        }

        const lineMappingsForSources: { [sourceIndex: number]: { [originalLine: number]: number } } = {}; {
            let line = 1;
            let sourceIndex = 0;
            let originalLine = 1;
            for (const [mapping, separator] of mappings.gmatch("([^;,]*)([;,]?)")) {
                const [colOffset, sourceOffset, origLineOffset, origColOffset] = decodeBase64VLQ(mapping);
                sourceIndex += (sourceOffset || 0);
                originalLine += (origLineOffset || 0);

                let lineMappings = lineMappingsForSources[sourceIndex];
                if (lineMappings === undefined) {
                    lineMappings = {};
                    lineMappingsForSources[sourceIndex] = lineMappings;
                }
                lineMappings[originalLine] = math.min(lineMappings[originalLine] || math.huge, line);

                if (separator === ";") {
                    ++line;
                }
            }
        }

        const sourceMap: SourceMap = {sources: []};

        for (const [source] of sources.gmatch('"([^"]+)"')) {
            table.insert(sourceMap.sources, source);
        }

        for (const [sourceIndex, lineMappings] of pairs(lineMappingsForSources)) {
            for (const [sourceLine, line] of pairs(lineMappings)) {
                sourceMap[line] = {sourceIndex, sourceLine};
            }
        }

        return sourceMap;
    }

    export function get(file: string): SourceMap | undefined {
        if (file === "[C]") {
            return undefined;
        }

        let sourceMap = cache[file];

        if (sourceMap === undefined) {
            sourceMap = false;

            //Look for map file
            const mapFile = file + ".map";
            let [f] = io.open(mapFile);
            if (f !== undefined) {
                const data = f.read("*a");
                f.close();
                sourceMap = build(data) || false;

            //Look for inline map
            } else {
                [f] = io.open(file);
                if (f !== undefined) {
                    const data = f.read("*a");
                    f.close();
                    const [encodedMap] = data.match(
                        "--# sourceMappingURL=data:application/json;base64,([A-Za-z0-9+/=]+)%s*$"
                    );
                    if (encodedMap !== undefined) {
                        const map = base64Decode(encodedMap);
                        sourceMap = build(map) || false;
                    }
                }
            }

            cache[file] = sourceMap;
        }

        return sourceMap || undefined;
    }
}

namespace Format {
    const indentStr = "  ";
    const escapes: Record<string, string> = {
        ["\n"]: "\\n",
        ["\r"]: "\\r",
        ["\""]: "\\\"",
        ["\\"]: "\\\\",
        ["\b"]: "\\b",
        ["\f"]: "\\f"
    };

    let escapesPattern = "";
    for (const [e] of pairs(escapes)) {
        escapesPattern += e;
    }

    function transformEscape(e: string) {
        return escapes[e];
    }

    function escape(str: string) {
        const [escaped] = str.gsub(escapesPattern, transformEscape);
        return escaped;
    }

    export function path(pathStr: string) {
        const firstChar = pathStr.sub(1, 1);
        if (firstChar === "@" || firstChar === "=") {
            pathStr = pathStr.sub(2);
        }
        [pathStr] = pathStr.gsub("\\", "/");
        return pathStr;
    }

    function formatLuaKey(key: string, indent: number, tables: {[t: string]: boolean}) {
        if (type(key) === "string") {
            const [validIdentifier] = key.match("^[a-zA-Z_][a-zA-Z0-9_]*$");
            if (validIdentifier !== undefined) {
                return key;
            }
        }
        return `["${escape(key)}"]`;
    }

    export function formatAsLua(val: unknown, indent = 0, tables?: {[t: string]: boolean}) {
        tables = tables || {};
        const valType = type(val);
        if (valType === "table" && !tables[val as keyof typeof tables]) {
            tables[val as keyof typeof tables] = true;

            const kvps: string[] = [];
            for (const [_, v] of ipairs(val as unknown[])) {
                const valStr = formatAsLua(v, indent + 1, tables);
                table.insert(kvps, `\n${indentStr.rep(indent + 1)}${valStr}`);
            }
            for (const [k, v] of pairs(val as object)) {
                const keyType = type(k);
                if (keyType !== "number" || (k as number) > (val as unknown[]).length) {
                    const keyStr = formatLuaKey(k, indent, tables);
                    const valStr = formatAsLua(v, indent + 1, tables);
                    table.insert(kvps, `\n${indentStr.rep(indent + 1)}${keyStr} = ${valStr}`);
                }
            }
            return (kvps.length > 0) ? `{${table.concat(kvps, ",")}\n${indentStr.rep(indent)}}` : "{}";

        } else if (valType === "number" || valType === "boolean") {
            return tostring(val);

        } else {
            return `"${escape(tostring(val))}"`;
        }
    }

    function isArray(val: unknown) {
        const len = (val as unknown[]).length;
        if (len === 0) {
            return false;
        }
        for (const [k] of pairs(val as object)) {
            if (type(k) !== "number" || (k as number) > len) {
                return false;
            }
        }
        return true;
    }

    export function formatAsJson(val: unknown, indent = 0, tables?: {[t: string]: boolean}) {
        tables = tables || {};
        const valType = type(val);
        if (valType === "table" && !tables[val as keyof typeof tables]) {
            tables[val as keyof typeof tables] = true;

            if (isArray(val)) {
                const arrayVals: string[] = [];
                for (const [_, arrayVal] of ipairs(val as unknown[])) {
                    const valStr = formatAsJson(arrayVal, indent + 1, tables);
                    table.insert(arrayVals, `\n${indentStr.rep(indent + 1)}${valStr}`);
                }
                return `[${table.concat(arrayVals, ",")}\n${indentStr.rep(indent)}]`;

            } else {
                const kvps: string[] = [];
                for (const [k, v] of pairs(val as object)) {
                    const valStr = formatAsJson(v, indent + 1, tables);
                    table.insert(kvps, `\n${indentStr.rep(indent + 1)}"${escape(tostring(k))}": ${valStr}`);
                }
                return (kvps.length > 0) ? `{${table.concat(kvps, ",")}\n${indentStr.rep(indent)}}` : "{}";
            }

        } else if (valType === "number" || valType === "boolean") {
            return tostring(val);

        } else {
            return `"${escape(tostring(val))}"`;
        }
    }

    export let format = formatAsJson;
}

namespace Send {
    export function error(err: string) {
        const errorObj: Error = {error: err};
        print(Format.format(errorObj));
    }

    export function debugBreak(msg: string) {
        print(Format.format({debugBreak: msg}));
    }

    export function result(value: unknown) {
        const resultObj: Result = {result: value};
        print(Format.format(resultObj));
    }

    export function frames(frameList: Frame[]) {
        const stackObj: Stack = {frames: frameList};
        print(Format.format(stackObj));
    }

    export function locals(locs: Locals) {
        const variablesObj: Variables = {variables: []};
        for (const [name, info] of pairs(locs)) {
            table.insert(variablesObj.variables, {name, type: info.type});
        }
        print(Format.format(variablesObj));
    }

    export function vars(varsObj: Vars) {
        const variablesObj: Variables = {variables: []};
        for (const [name, info] of pairs(varsObj)) {
            table.insert(variablesObj.variables, {name, type: info.type});
        }
        print(Format.format(variablesObj));
    }

    export function breakpoints(breaks: Breakpoint[]) {
        const breakpointsObj: Breakpoints = {breakpoints: breaks};
        print(Format.format(breakpointsObj));
    }

    export function help(helpStrs: string[]) {
        print(Format.format(helpStrs));
    }
}

namespace Debugger {
    interface Env {
        [name: string]: unknown;
    }

    /** @tupleReturn */
    declare function load(
        this: void,
        chunk: string,
        chunkname?: string,
        mode?: "b" | "t" | "bt",
        env?: Object
    ): [{ (this: void): unknown }, undefined] | [undefined, string];

    /** @tupleReturn */
    function loadCode(code: string, env?: Env): [{ (this: void): unknown }, undefined] | [undefined, string] {
        if (loadstring) {
            const [f, e] = loadstring(code, code);
            if (f && env) {
                setfenv(f, env);
            }
            return [f, e] as [{ (this: void): unknown }, undefined] | [undefined, string];

        } else {
            return load(code, code, "t", env);
        }
    }

    function backtrace(stack: debug.FunctionInfo[], frameIndex: number) {
        const frames: Frame[] = [];
        for (let i = 0; i < stack.length; ++i) {
            const info = stack[i];
            const frame: Frame = {
                source: info.source && Format.path(info.source) || "?",
                line: info.currentline && assert(tonumber(info.currentline)) || -1
            };
            if (info.source && info.currentline) {
                const sourceMap = SourceMap.get(frame.source);
                if (sourceMap) {
                    const lineMapping = sourceMap[frame.line];
                    if (lineMapping !== undefined) {
                        if (sourceMap.sources) {
                            frame.mappedSource = assert(sourceMap.sources[lineMapping.sourceIndex]);
                        }
                        frame.mappedLine = sourceMap[frame.line].sourceLine;
                    }
                }
            }
            if (info.name) {
                frame.func = info.name;
            }
            if (i === frameIndex) {
                frame.active = true;
            }
            table.insert(frames, frame);
        }
        Send.frames(frames);
    }

    function getLocals(level: number): Locals {
        const locs: Locals = {};

        for (let index = 1; ; ++index) {
            const [name, val] = debug.getlocal(level + 1, index);
            if (name === undefined) {
                break;
            }
            if (name.sub(1, 1) !== "(") {
                locs[name] = {val, index, type: type(val)};
            }
        }

        return locs;
    }

    function getUpvalues(info: debug.FunctionInfo): Locals {
        const ups: Locals = {};

        info.nups = assert(info.nups);
        info.func = assert(info.func);
        for (let index = 1; index <= info.nups; ++index) {
            const [name, val] = debug.getupvalue(info.func, index);
            ups[assert(name)] = {val, index, type: type(val)};
        }

        return ups;
    }

    function getGlobals(): Vars {
        const globs: Vars = {};
        for (const [key, val] of pairs(_G)) {
            const name = tostring(key);
            globs[name] = {val, type: type(val)};
        }
        return globs;
    }

    let breakAtDepth = 0;

    export function getInput() {
        io.stdout.write("> ");
        const inp = io.stdin.read("*l");
        return inp;
    }

    export function debugBreak(stack: debug.FunctionInfo[]) {
        breakAtDepth = 0;
        const frameOffset = 3;
        let frame = 0;
        let info = stack[frame];
        backtrace(stack, frame);
        while (true) {
            const inp = getInput();
            if (inp === undefined || type(inp) === "number" || inp === "cont" || inp === "continue") {
                break;

            } else if (inp === "help") {
                Send.help(
                    [
                        "help                         : show available commands",
                        "cont|continue                : continue execution",
                        "quit                         : stop program and debugger",
                        "step                         : step to next line",
                        "stepin                       : step in to current line",
                        "stepout                      : step out to calling line",
                        "stack                        : show current stack trace",
                        "frame n                      : set active stack frame",
                        "locals                       : show all local variables available in current context",
                        "ups                          : show all upvalue variables available in the current context",
                        "globals                      : show all global variables in current environment",
                        "eval                         : evaluate an expression in the current context",
                        "exec                         : execute a statement in the current context",
                        "break [list]                 : show all breakpoints",
                        "break set file.ext:n         : set a breakpoint",
                        "break del|delete file.ext:n  : delete a breakpoint",
                        "break en|enable file.ext:n   : enable a breakpoint",
                        "break dis|disable file.ext:n : disable a breakpoint",
                        "break clear                  : delete all breakpoints",
                    ]
                );

            } else if (inp === "step") {
                breakAtDepth = stack.length;
                break;

            } else if (inp === "stepin") {
                breakAtDepth = math.huge;
                break;

            } else if (inp === "stepout") {
                breakAtDepth = stack.length - 1;
                break;

            } else if (inp === "quit") {
                os.exit(0);

            } else if (inp === "stack") {
                backtrace(stack, frame);

            } else if (inp.sub(1, 5) === "frame") {
                const [newFrameStr] = inp.match("^frame%s+(%d+)$");
                const newFrame = assert(tonumber(newFrameStr));
                if (newFrame !== undefined && newFrame > 0 && newFrame <= stack.length) {
                    frame = newFrame - 1;
                    info = stack[newFrame];
                    backtrace(stack, frame);
                } else {
                    Send.error("Bad frame");
                }

            } else if (inp === "locals") {
                const locs = getLocals(frameOffset + frame);
                Send.vars(locs);

            } else if (inp === "ups") {
                const ups = getUpvalues(info);
                Send.vars(ups);

            } else if (inp === "globals") {
                const globs = getGlobals();
                Send.vars(globs);

            } else if (inp === "break") {
                Send.breakpoints(Breakpoint.getAll());

            } else if (inp.sub(1, 5) === "break") {
                const [cmd] = inp.match("^break%s+([a-z]+)");
                let file: string | undefined;
                let line: number | undefined;
                let breakpoint: Breakpoint | undefined;
                if (cmd === "set"
                    || cmd === "del"
                    || cmd === "delete"
                    || cmd === "dis"
                    || cmd === "disable"
                    || cmd === "en"
                    || cmd === "enable"
                ) {
                    let lineStr: string | undefined;
                    [file, lineStr] = inp.match("^break%s+[a-z]+%s+([^:]+):(%d+)$");
                    if (file !== undefined && lineStr !== undefined) {
                        file = Format.path(file);
                        line = assert(tonumber(lineStr));
                        breakpoint = Breakpoint.get(file, line);
                    }
                }
                if (cmd === "set") {
                    if (file !== undefined && line !== undefined) {
                        Breakpoint.add(file, line);
                    } else {
                        Send.error("Bad breakpoint");
                    }

                } else if (cmd === "del" || cmd === "delete") {
                    if (file !== undefined && line !== undefined) {
                        Breakpoint.remove(file, line);

                    } else {
                        Send.error("Bad breakpoint");
                    }

                } else if (cmd === "dis" || cmd === "disable") {
                    if (breakpoint !== undefined) {
                        breakpoint.enabled = false;
                    } else {
                        Send.error("Bad breakpoint");
                    }

                } else if (cmd === "en" || cmd === "enable") {
                    if (breakpoint !== undefined) {
                        breakpoint.enabled = true;
                    } else {
                        Send.error("Bad breakpoint");
                    }

                } else if (cmd === "clear") {
                    Breakpoint.clear();

                } else if (cmd === "list") {
                    Send.breakpoints(Breakpoint.getAll());

                } else {
                    Send.error("Bad breakpoint command");
                }

            } else if (inp.sub(1, 4) === "eval") {
                const [expression] = inp.match("^eval%s+(.+)$");
                if (expression === undefined) {
                    Send.error("Bad expression");
                } else {
                    const env: Env = setmetatable({}, {__index: _G});

                    const ups = getUpvalues(info);
                    for (const [name, val] of pairs(ups)) {
                        env[name] = val.val;
                    }

                    const vars = getLocals(frameOffset + frame);
                    for (const [name, val] of pairs(vars)) {
                        env[name] = val.val;
                    }

                    const [f, e] = loadCode(`return ${expression}`, env);
                    if (f !== undefined) {
                        const [s, r] = pcall(f);
                        if (s) {
                            Send.result(r);
                        } else {
                            Send.error(r as string);
                        }
                    } else {
                        Send.error(e as string);
                    }
                }

            } else if (inp.sub(1, 4) === "exec") {
                const [statement] = inp.match("^exec%s+(.+)$");
                if (statement === undefined) {
                    Send.error("Bad statement");

                } else {
                    const vars = getLocals(frameOffset + frame);
                    const ups = getUpvalues(info);
                    const env = setmetatable(
                        {},
                        {
                            __index(this: unknown, name: string) {
                                const v = vars[name] || ups[name];
                                return (v !== undefined) && v.val || _G[name];
                            },
                            __newindex(this: unknown, name: string, val: unknown) {
                                let v = vars[name];
                                if (v !== undefined) {
                                    let extraStack = 1;
                                    while (debug.getinfo(frameOffset + stack.length + extraStack)) {
                                        ++extraStack;
                                    }
                                    debug.setlocal(frameOffset + frame + extraStack, v.index, val);
                                    return;
                                }

                                v = ups[name];
                                if (v !== undefined) {
                                    debug.setupvalue(assert(info.func), v.index, val);
                                    return;
                                }

                                _G[name] = val;
                            }
                        }
                    );
                    const [f, e] = loadCode(statement, env);
                    if (f !== undefined) {
                        const [_, r] = pcall(f);
                        if (r !== undefined) {
                            Send.result(r);
                        }
                    } else {
                        Send.error(e as string);
                    }
                }

            } else {
                Send.error("Bad command");
            }
        }
    }

    export function getStack(): debug.FunctionInfo[] | undefined {
        const info = debug.getinfo(3, "nSluf");
        if (!info.source) {
            return undefined;
        }

        const [isDebugger] = info.source.match("[/\\]?debugger%.lua$");
        if (isDebugger !== undefined) {
            return undefined;
        }

        const stack: debug.FunctionInfo[] = [info];
        let i = 4;
        while (true) {
            const stackInfo = debug.getinfo(i, "nSluf");
            if (stackInfo === undefined) {
                break;
            }
            table.insert(stack, stackInfo);
            ++i;
        }
        return stack;
    }

    function debugHook(event: "call" | "return" | "tail return" | "count" | "line", line?: number) {
        const stack = getStack();
        if (!stack) {
            return;
        }

        if (stack.length <= breakAtDepth) {
            debugBreak(stack);
            return;
        }

        const info = stack[0];
        const breakpoints = Breakpoint.getAll();
        if (info.currentline === undefined || breakpoints.length === 0) {
            return;
        }

        const source = Format.path(assert(info.source));
        const sourceMap = SourceMap.get(source);
        const lineMapping = sourceMap && sourceMap[info.currentline];
        // tslint:disable-next-line: no-non-null-assertion
        const sourceMapFile = lineMapping && sourceMap!.sources[lineMapping.sourceIndex];
        for (const [_, breakpoint] of ipairs(breakpoints)) {
            if (breakpoint.enabled) {
                let fileMatch: string | undefined;
                if (breakpoint.line === info.currentline) {
                    [fileMatch] = source.match(breakpoint.pattern);

                } else if (lineMapping && breakpoint.line === lineMapping.sourceLine) {
                    // tslint:disable-next-line: no-non-null-assertion
                    [fileMatch] = sourceMapFile!.match(breakpoint.pattern);
                }

                if (fileMatch !== undefined) {
                    Send.debugBreak(`breakpoint hit: "${breakpoint.file}:${breakpoint.line}"`);
                    debugBreak(stack);
                    break;
                }
            }
        }
    }

    export function setHook() {
        debug.sethook(debugHook, "l");
    }

    export function clearHook() {
        debug.sethook();
    }

    export function triggerBreak() {
        breakAtDepth = math.huge;
    }

    //Attempt to convert all line-leading source file locations using source maps
    export function mapSources(msg: string) {
        let result = "";
        for (let [msgLine] of msg.gmatch("[^\r\n]+[\r\n]*")) {
            const [_, e, indent, file, lineStr] = msgLine.find("^(%s*)(.+):(%d+):");
            if (e && file && lineStr) {
                const line = assert(tonumber(lineStr));
                const sourceMap = SourceMap.get(file);
                if (sourceMap && sourceMap[line]) {
                    const sourceFile = sourceMap.sources[sourceMap[line].sourceIndex];
                    const sourceLine = sourceMap[line].sourceLine;
                    msgLine = `${indent}${sourceFile}:${sourceLine}:${msgLine.sub(e + 1)}`;
                }
            }
            result += msgLine;
        }
        return result;
    }
}

//Override traceback to catch thrown errors
const debugTraceback = debug.traceback;

debug.traceback = function(
    threadOrMessage?: LuaThread | string,
    messageOrLevel?: string | number,
    level?: number
) {
    let message: string | undefined;
    let traceback: string;
    if (type(threadOrMessage) === "thread") {
        if (messageOrLevel) {
            message = Debugger.mapSources(messageOrLevel as string);
        }
        traceback =  Debugger.mapSources(debugTraceback(threadOrMessage as LuaThread, message, level));

    } else {
        if (threadOrMessage) {
            message = Debugger.mapSources(threadOrMessage as string);
        }
        traceback = Debugger.mapSources(debugTraceback(message, messageOrLevel as number | undefined));
    }

    const stack = Debugger.getStack();
    if (stack) {
        Send.debugBreak(message && ("error: " + message) || "error");
        Debugger.debugBreak(stack);
    }
    return traceback;
};

//Trigger a break at next executed line
export function requestBreak() {
    Debugger.triggerBreak();
}

//Start debugger
export function start(breakImmediately = true, useJson = false) {
    Format.format = useJson && Format.formatAsJson || Format.formatAsLua;

    Debugger.setHook();

    if (breakImmediately) {
        Debugger.triggerBreak();
    }
}

//Stop debugger
export function stop() {
    Debugger.clearHook();
}
