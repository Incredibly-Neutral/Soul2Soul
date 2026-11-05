// ============================================================================
// Minimal terminal prompting — node:readline only.
//
// The CLI is headless-first: stdout carries the result envelope and nothing
// else, so questions and the typed echo go to stderr. Two properties matter:
//
//   * a NON-TTY stdin (a pipe, a CI run, the Neovim plugin) never blocks —
//     `prompt()` resolves `undefined` immediately, and the caller treats that
//     as "no answer", the same as pressing enter;
//   * `{ secret: true }` turns the echo off, so a pasted JWT does not land in
//     the scrollback.
//
// No state is kept between calls: every prompt owns its interface and closes
// it. SIGINT (ctrl-c) resolves `undefined` and lets the command decide.
// ============================================================================

import { createInterface } from 'node:readline';

export interface PromptTargets {
  /** Defaults to process.stdin. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Defaults to process.stderr — stderr keeps stdout clean for the result. */
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface PromptOptions extends PromptTargets {
  /** Echo nothing typed (keys, tokens). */
  secret?: boolean;
}

/** Both ends must be a terminal — a redirected stream has nobody listening. */
export function isInteractive(targets: PromptTargets = {}): boolean {
  const input = targets.input ?? process.stdin;
  const output = targets.output ?? process.stderr;
  return input.isTTY === true && output.isTTY === true;
}

/**
 * Ask one question. Resolves the typed line (trimmed by the caller), or
 * `undefined` when there is no TTY, the stream closed, or the user pressed
 * ctrl-c.
 */
export function prompt(question: string, options: PromptOptions = {}): Promise<string | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (!isInteractive({ input, output })) return Promise.resolve(undefined);

  return new Promise<string | undefined>((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    let settled = false;
    const settle = (answer: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };

    // Echo off: the line editor's own writes are the only thing that redraws
    // the typed characters, so swallowing them hides the input. The question
    // and the trailing newline (the enter key keeps its echo otherwise) are
    // printed here instead.
    if (options.secret) {
      const editor = rl as unknown as { _writeToOutput?: (chunk: string) => void };
      editor._writeToOutput = (): void => {
        // swallow the echo — the typed secret must not reach the terminal
      };
      output.write(question);
    }

    const finish = (answer: string | undefined): void => {
      if (options.secret) output.write('\n');
      settle(answer);
      rl.close();
    };

    rl.question(options.secret ? '' : question, (answer: string) => {
      finish(answer);
    });
    rl.on('SIGINT', () => {
      finish(undefined);
    });
    rl.on('close', () => {
      settle(undefined);
    });
  });
}
