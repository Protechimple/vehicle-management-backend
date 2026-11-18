// Creates a Super Admin account. Run once per person: npm run create-super-admin
const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const env = require('../src/config/env');
const { sequelize, connectDatabase, disconnectDatabase } = require('../src/config/database');
const { PlatformAdmin } = require('../src/models');
const { requireText, requireEmail, requirePassword } = require('../src/utils/validation');

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let muted = false;

  // Hide what is typed for the password, but still show the question itself.
  const write = rl._writeToOutput?.bind(rl);
  if (write) {
    rl._writeToOutput = (text) => {
      if (!muted) write(text);
    };
  }

  const lines = rl[Symbol.asyncIterator]();

  async function ask(question, { secret = false } = {}) {
    process.stdout.write(question);
    muted = secret;
    const { value, done } = await lines.next();
    muted = false;
    if (secret) process.stdout.write('\n');
    if (done) throw new Error('Input ended before all details were entered');
    return value;
  }

  return { ask, close: () => rl.close() };
}

async function main() {
  const prompt = createPrompt();

  try {
    console.log('\nCreate a VMMS Super Admin\n');
    const name = requireText(await prompt.ask('Name: '), 'Name', { max: 150 });
    const email = requireEmail(await prompt.ask('Email: '));
    const password = requirePassword(await prompt.ask('Password (min 8 characters): ', { secret: true }));
    const confirmation = await prompt.ask('Confirm password: ', { secret: true });
    if (password !== confirmation) throw new Error('Passwords do not match');

    await connectDatabase();

    if (await PlatformAdmin.findOne({ where: { email } })) {
      throw new Error(`A Super Admin with the email ${email} already exists`);
    }

    const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
    await PlatformAdmin.create({ name, email, passwordHash, status: 'active' });

    console.log(`\nSuper Admin created: ${email}`);
    console.log(`Sign in at ${env.clientUrl}/platform/login\n`);
  } catch (error) {
    console.error(`\nCould not create the Super Admin: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    prompt.close();
    if (sequelize) await disconnectDatabase().catch(() => {});
  }
}

main();
