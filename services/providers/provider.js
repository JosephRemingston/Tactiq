export class ProviderNotConfiguredError extends Error {
  constructor() {
    super(...arguments);
    this.name = "ProviderNotConfiguredError";
  }
}
export class ProviderSchemaError extends Error {
  constructor() {
    super(...arguments);
    this.name = "ProviderSchemaError";
  }
}
