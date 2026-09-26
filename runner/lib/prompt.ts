import { createInterface } from "node:readline/promises";

/**
 * Terminal questions for `npm run setup`. Tests pass a scripted Prompter; the
 * CLI uses the terminal one. With `--yes` setup never asks anything.
 */
export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Input is not echoed (API keys). */
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
}

export class PromptUnavailableError extends Error {
  override readonly name = "PromptUnavailableError";
}

/** A prompter for non-interactive runs: every question is an error naming the flag to pass instead. */
export const noPrompter: Prompter = {
  ask: async (question) => {
    throw new PromptUnavailableError(`Setup needs an answer to "${question.trim()}" but is running non-interactively. Pass the value as a flag.`);
  },
  askSecret: async (question) => {
    throw new PromptUnavailableError(`Setup needs "${question.trim()}" but is running non-interactively.`);
  },
  confirm: async (question) => {
    throw new PromptUnavailableError(`Setup needs a yes or no to "${question.trim()}" but is running non-interactively. Pass --yes.`);
  },
};

async function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  if (!stdin.isTTY) throw new PromptUnavailableError("A secret can only be typed in a terminal.");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new PromptUnavailableError("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

export function terminalPrompter(): Prompter {
  return {
    async ask(question, defaultValue) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(defaultValue ? `${question} [${defaultValue}] ` : `${question} `)).trim();
        return answer || defaultValue || "";
      } finally {
        rl.close();
      }
    },
    askSecret: readHidden,
    async confirm(question, defaultValue) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        if (!answer) return defaultValue;
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },
  };
}

/** A prompter answering from a list, for tests. Throws when it runs out. */
export function scriptedPrompter(answers: readonly string[]): Prompter & { readonly asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new PromptUnavailableError(`No scripted answer for "${question}".`);
    return answer;
  };
  return {
    asked,
    ask: async (question, defaultValue) => next(question) || defaultValue || "",
    askSecret: async (question) => next(question),
    confirm: async (question, defaultValue) => {
      const answer = next(question).trim().toLowerCase();
      return answer === "" ? defaultValue : answer === "y" || answer === "yes";
    },
  };
}
