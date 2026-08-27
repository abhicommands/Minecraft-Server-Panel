export const PASSWORD_PATTERN = /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};:'",.<>?/]*$/;
export const USERNAME_PATTERN = /^[a-z0-9]+$/i;

export function validatePanelUsername(username: string): void {
  if (username.length < 3 || username.length > 30 || !USERNAME_PATTERN.test(username)) {
    throw new Error("Username must be 3-30 ASCII letters or numbers");
  }
}

export function validatePanelPassword(password: string): void {
  if (password.length < 6 || password.length > 50 || !PASSWORD_PATTERN.test(password)) {
    throw new Error("Password must be 6-50 supported ASCII characters");
  }
}

export async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("An interactive terminal is required to enter the password securely");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";

  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish(new Error("Password entry cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function promptAndHashPassword(): Promise<string> {
  const password = await hiddenPrompt("Password: ");
  const confirmation = await hiddenPrompt("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match");
  validatePanelPassword(password);
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}
