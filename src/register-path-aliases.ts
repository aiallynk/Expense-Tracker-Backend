const moduleAlias = require('module-alias') as {
  addAlias(alias: string, target: string): void;
};

// Register "@/" against the current runtime root.
// In development this file runs from "src", and in production it runs from "dist".
moduleAlias.addAlias('@', __dirname);
