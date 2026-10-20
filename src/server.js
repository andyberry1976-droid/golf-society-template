'use strict';
const { open } = require('./db'); const { createApp } = require('./app'); const { ensureAdmin } = require('./bootstrap');
const db = open(process.env.DATABASE_PATH || 'data/society.db');
ensureAdmin(db);
const port = +process.env.PORT || 3000;
createApp(db).listen(port, () => console.log(`Golf society site on http://localhost:${port}`));
