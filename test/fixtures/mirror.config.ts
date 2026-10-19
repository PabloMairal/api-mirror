import { defineConfig } from '../../src/index.ts';
import { itemsSource } from '../support/items-source.ts';

// Used by the tests that run the real CLI in a child process.
const schema = process.env.MIRROR_SCHEMA!;
export default defineConfig({
  schema,
  sources: [itemsSource(process.env.FAKE_API_URL!, `${schema}.items`, 'link', Number(process.env.PAGE_SIZE ?? 3))],
});
