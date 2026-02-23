# clanka-api

Cloudflare Worker API for presence/status and admin task management.

## Authentication

Admin endpoints require:

- Header: `Authorization: Bearer <ADMIN_KEY>`

## Endpoints

### `GET /status`
Returns service health metadata.

Example response:

```json
{
  "status": "operational",
  "timestamp": "2026-02-23T12:34:56.000Z",
  "signal": "⚡"
}
```

### `GET /now`
Returns current presence plus recent activity/team data.

Example response includes:

- `current`
- `status`
- `stack`
- `timestamp`
- `history`
- `team`

### `POST /set-presence`
Sets presence and optionally updates tasks/team/history.

Auth: admin required.

JSON body fields:

- `state` (string)
- `message` (string)
- `ttl` (number, seconds)
- `activity` (object)
- `team` (object)
- `tasks` (array)

### `GET /admin/tasks`
Returns all tasks.

Auth: admin required.

### `POST /admin/tasks`
Adds one task.

Auth: admin required.

JSON body: task object (stored as-is).

### `PUT /admin/tasks`
Updates a task by `id`.

Auth: admin required.

JSON body: object containing `id` and updated fields.

### `DELETE /admin/tasks`
Deletes a task by `id`.

Auth: admin required.

JSON body:

```json
{
  "id": "task-id"
}
```
