const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(async (req, res, next) => {
  await db.init();
  next();
});

app.use('/api/classes', require('./routes/classes'));
app.use('/api/students', require('./routes/students'));
app.use('/api/routines', require('./routes/routines'));
app.use('/api/checks', require('./routes/checks'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/encouragements', require('./routes/encouragements'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/rewards', require('./routes/rewards'));

module.exports = app;
