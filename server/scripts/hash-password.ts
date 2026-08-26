import {
  escapedBcryptEnvironmentValue,
  promptAndHashPassword,
} from "../utils/password.ts";

try {
  const hash = await promptAndHashPassword();
  console.log("\nPaste this complete line into server/.env:");
  console.log(`ROOT_PASSWORD_HASH=${escapedBcryptEnvironmentValue(hash)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
