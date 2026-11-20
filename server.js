
import express from 'express';
import Database from 'better-sqlite3';

const app = express();

// Enable CORS so the frontend (port 3000) can access the backend (port 3001).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Parse incoming JSON request bodies.
app.use(express.json());

// Connect to the SQLite database.
const db = new Database('./clients.db');

// Close database when the server stops.
const closeDb = () => db.close();

process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

const validStatuses = ['backlog', 'in-progress', 'complete'];

// GET all clients or filter by status.
app.get('/api/v1/clients', (req, res) => {
  const { status } = req.query;

  if (status && !validStatuses.includes(status)) {
    return res.status(400).send({
      message: 'Invalid status provided.',
      long_message:
        'Status can only be backlog, in-progress or complete.',
    });
  }

  const clients = status
    ? db.prepare(
        'SELECT * FROM clients WHERE status = ? ORDER BY priority'
      ).all(status)
    : db.prepare(
        'SELECT * FROM clients ORDER BY status, priority'
      ).all();

  return res.status(200).send(clients);
});

// GET one client by ID.
app.get('/api/v1/clients/:id', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).send({
      message: 'Invalid id provided.',
    });
  }

  const client = db
    .prepare('SELECT * FROM clients WHERE id = ?')
    .get(id);

  if (!client) {
    return res.status(400).send({
      message: 'Cannot find client with that id.',
    });
  }

  return res.status(200).send(client);
});

// PUT: Save the complete Kanban board order.
// This route must appear BEFORE /:id.
app.put('/api/v1/clients/reorder', (req, res) => {
  const lanes = req.body.lanes;

  if (!lanes || typeof lanes !== 'object') {
    return res.status(400).send({
      message: 'Invalid lanes provided.',
    });
  }

  const allIds = [];

  for (const status of validStatuses) {
    if (!Array.isArray(lanes[status])) {
      return res.status(400).send({
        message: `Missing or invalid lane: ${status}`,
      });
    }

    allIds.push(...lanes[status]);
  }

  const existingIds = db
    .prepare('SELECT id FROM clients')
    .all()
    .map(client => client.id);

  if (
    allIds.length !== existingIds.length ||
    new Set(allIds).size !== allIds.length ||
    allIds.some(
      id => !Number.isInteger(id) || !existingIds.includes(id)
    )
  ) {
    return res.status(400).send({
      message: 'Every client must appear exactly once.',
    });
  }

  const saveOrder = db.transaction(() => {
    // Temporary priorities prevent conflicts during reordering.
    db.prepare('UPDATE clients SET priority = -id').run();

    const updateClient = db.prepare(
      'UPDATE clients SET status = ?, priority = ? WHERE id = ?'
    );

    validStatuses.forEach(status => {
      lanes[status].forEach((id, index) => {
        updateClient.run(status, index + 1, id);
      });
    });
  });

  try {
    saveOrder();

    const updatedClients = db
      .prepare('SELECT * FROM clients ORDER BY status, priority')
      .all();

    return res.status(200).send(updatedClients);
  } catch (error) {
    return res.status(500).send({
      message: 'Could not save board order.',
      long_message: error.message,
    });
  }
});

// PUT: Update an individual client's status and priority.
app.put('/api/v1/clients/:id', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).send({
      message: 'Invalid id provided.',
    });
  }

  const client = db
    .prepare('SELECT * FROM clients WHERE id = ?')
    .get(id);

  if (!client) {
    return res.status(400).send({
      message: 'Cannot find client with that id.',
    });
  }

  const newStatus =
    req.body.status === undefined
      ? client.status
      : req.body.status;

  if (!validStatuses.includes(newStatus)) {
    return res.status(400).send({
      message: 'Invalid status provided.',
    });
  }

  const saveOrder = db.transaction(() => {
    const lanes = {
      backlog: db.prepare(
        'SELECT id FROM clients WHERE status = ? ORDER BY priority'
      ).all('backlog').map(row => row.id),

      'in-progress': db.prepare(
        'SELECT id FROM clients WHERE status = ? ORDER BY priority'
      ).all('in-progress').map(row => row.id),

      complete: db.prepare(
        'SELECT id FROM clients WHERE status = ? ORDER BY priority'
      ).all('complete').map(row => row.id),
    };

    const oldLane = lanes[client.status];
    const oldIndex = oldLane.indexOf(id);

    oldLane.splice(oldIndex, 1);

    const newLane = lanes[newStatus];

    const requestedPriority =
      req.body.priority === undefined
        ? newLane.length + 1
        : req.body.priority;

    if (
      !Number.isInteger(requestedPriority) ||
      requestedPriority < 1 ||
      requestedPriority > newLane.length + 1
    ) {
      throw new Error('Invalid priority provided.');
    }

    newLane.splice(requestedPriority - 1, 0, id);

    db.prepare('UPDATE clients SET priority = -id').run();

    const updateClient = db.prepare(
      'UPDATE clients SET status = ?, priority = ? WHERE id = ?'
    );

    validStatuses.forEach(status => {
      lanes[status].forEach((clientId, index) => {
        updateClient.run(status, index + 1, clientId);
      });
    });
  });

  try {
    saveOrder();

    const updatedClients = db
      .prepare('SELECT * FROM clients ORDER BY status, priority')
      .all();

    return res.status(200).send(updatedClients);
  } catch (error) {
    return res.status(400).send({
      message: error.message,
    });
  }
});

// Start server.
app.listen(3001, () => {
  console.log('App running on port 3001');
});
