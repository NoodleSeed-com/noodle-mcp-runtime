import { expect, it } from 'vitest';
import { assertExternalSchemaProfile } from '../src/schema-contract.js';

it('rejects unsupported external profiles before opening a database', () => {
  expect(() => assertExternalSchemaProfile({ schemaMode: 'external' })).toThrow('canonical');
  expect(() =>
    assertExternalSchemaProfile({
      databaseUrl: 'postgres://localhost/test',
      schemaMode: 'external',
      modules: ['custom'],
    }),
  ).toThrow('canonical');
  expect(() =>
    assertExternalSchemaProfile({
      databaseUrl: 'postgres://localhost/test',
      schemaMode: 'external',
      businessInformationEnabled: false,
    }),
  ).toThrow('canonical');
});
