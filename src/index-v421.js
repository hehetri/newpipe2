"use strict";

// Compatibilidade com deploys antigos que apontavam o start command para este
// arquivo. O addon real vive em src/index.js, sem patches em tempo de execução.
module.exports = require("./index.js");
