const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('OK');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', firm: process.env.FIRM || 'unset' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} | FIRM=${process.env.FIRM || 'unset'}`);
});
