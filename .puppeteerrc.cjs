const { join } = require("node:path");

module.exports = {
  cacheDirectory: join(__dirname, "node_modules", ".cache", "puppeteer")
};
