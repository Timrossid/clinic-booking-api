// Creates the throwaway database used by the test suite.
const { Client } = require("pg");

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const TARGET = process.env.TEST_DB_NAME || "clinic_test";

async function main() {
  if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL is required");
  const client = new Client({
    connectionString: ADMIN_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [TARGET]);
  if (exists.rowCount) {
    console.log(`database ${TARGET} already exists`);
  } else {
    await client.query(`CREATE DATABASE ${JSON.stringify(TARGET).replace(/"/g, '"')}`);
    console.log(`created database ${TARGET}`);
  }
  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
