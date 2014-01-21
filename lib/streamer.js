// Load modules

var Hoek = require('hoek');
var Boom = require('boom');
var SocketIO = require('socket.io');
var Project = require('./project');
var Session = require('./session');


// Declare internals

var internals = {};


module.exports = internals.Manager = function (env) {

    this.env = env;
    this.updatesQueue = [];     // Updates queue
    this.socketsById = {};      // { _id_: { socket: _socket_, userId: _userId_ }, ... }
    this.idsByProject = {};     // { _projectId_: { _id_: true, ... }, ... }
    this.idsByUserId = {};      // { _userId_: { _id_: true, ... }, ... }
    this.projectsById = {};     // { _id_: { _projectId_: true, ... }, ... }
    this.io = null;
};


internals.Manager.prototype.initialize = function (server) {

    var self = this;

    this.io = SocketIO.listen(server.listener, { 'log level': 0 });
    this.io.sockets.on('connection', function (socket) {

        // Add to sockets map

        self.socketsById[socket.id] = { socket: socket };

        // Setup handlers

        socket.on('message', internals.messageHandler(self, socket));
        socket.on('disconnect', internals.disconnectHandler(self, socket));

        // Send session id

        socket.json.send({ type: 'connect', session: socket.id });
    });

    var processUpdates = function () {

        for (var i = 0, il = self.updatesQueue.length; i < il; ++i) {
            var update = self.updatesQueue[i];
            var updatedIds = '';

            switch (update.object) {
                case 'project':
                case 'tasks':
                case 'task':
                case 'details':

                    // Lookup project list

                    var ids = self.idsByProject[update.project];
                    if (ids) {
                        for (var s in ids) {
                            if (ids.hasOwnProperty(s)) {
                                if (self.socketsById[s] &&
                                    self.socketsById[s].socket) {

                                    self.socketsById[s].socket.json.send(update);
                                    updatedIds += ' ' + s;
                                }
                            }
                        }
                    }

                    break;

                case 'profile':
                case 'contacts':
                case 'projects':

                    var ids = self.idsByUserId[update.user];
                    if (ids) {
                        for (var s in ids) {
                            if (ids.hasOwnProperty(s)) {
                                if (self.socketsById[s] &&
                                    self.socketsById[s].socket) {

                                    self.socketsById[s].socket.json.send(update);
                                    updatedIds += ' ' + s;
                                }
                            }
                        }
                    }

                    break;
            }
        }

        self.updatesQueue = [];
    };

    setInterval(processUpdates, 1000);
};


// Add update to queue

internals.Manager.prototype.update = function (update, request) {

    update.type = 'update';

    if (request) {
        if (request.auth.credentials.user) {
            update.by = request.auth.credentials.user;
        }

        if (request.auth.credentials &&
            request.auth.credentials.id) {

            update.macId = request.auth.credentials.id.slice(-8);
        }
    }

    this.updatesQueue.push(update);
};


// Subscribe

internals.Manager.prototype.subscribe = function () {

    var manager = this;

    return {
        handler: function (request, reply) {

            // Lookup socket

            if (!manager.socketsById[request.params.id] ||
                !manager.socketsById[request.params.id].socket) {

                return reply(Boom.notFound('Streamer not found'));
            }

            if (!manager.socketsById[request.params.id].userId) {
                return reply(Boom.badRequest('Streamer not initialized'));
            }

            if (manager.socketsById[request.params.id].userId !== request.auth.credentials.user) {
                return reply(Boom.forbidden());
            }

            var socket = manager.socketsById[request.params.id].socket;

            // Lookup project

            Project.load(this.db, request.params.project, request.auth.credentials.user, false, function (err, project, member) {

                if (err) {
                    return reply(err);
                }

                // Add to subscriber list

                manager.idsByProject[project._id] = manager.idsByProject[project._id] || {};
                manager.idsByProject[project._id][request.params.id] = true;

                // Add to cleanup list

                manager.projectsById[request.params.id] = manager.projectsById[request.params.id] || {};
                manager.projectsById[request.params.id][project._id] = true;

                // Send ack via the stream

                socket.json.send({ type: 'subscribe', project: project._id });

                // Send ack via the request

                return reply({ status: 'ok' });
            });
        }
    };
};


// Unsubscribe

internals.Manager.prototype.unsubscribe = function () {

    var manager = this;

    return {
        handler: function (request, reply) {

            // Lookup socket

            if (!manager.socketsById[request.params.id] ||
                !manager.socketsById[request.params.id].socket) {

                return reply(Boom.notFound('Streamer not found'));
            }

            if (!manager.socketsById[request.params.id].userId) {
                return reply(Boom.badRequest('Streamer not initialized'));
            }

            if (manager.socketsById[request.params.id].userId !== request.auth.credentials.user) {
                return reply(Boom.forbidden());
            }

            var socket = manager.socketsById[request.params.id].socket;

            // Remove from subscriber list

            if (!manager.idsByProject[request.params.project] ||
                !manager.idsByProject[request.params.project][request.params.id]) {

                return reply(Boom.notFound('Project subscription not found'));
            }

            delete manager.idsByProject[request.params.project][request.params.id];

            // Remove from cleanup list

            if (manager.projectsById[request.params.id]) {
                delete manager.projectsById[request.params.id][request.params.project];
            }

            // Send ack via the stream

            socket.json.send({ type: 'unsubscribe', project: request.params.project });

            // Send ack via the request

            return reply({ status: 'ok' });
        }
    };
};


// Force unsubscribe

internals.Manager.prototype.drop = function (userId, projectId) {

    var userIds = this.idsByUserId[userId];
    if (userIds) {
        var projectIds = this.idsByProject[projectId];
        if (projectIds) {
            for (var i in userIds) {
                if (userIds.hasOwnProperty(i)) {
                    if (projectIds[i]) {
                        delete this.idsByProject[projectId][i];

                        // Send ack via the stream

                        if (this.socketsById[i] &&
                            this.socketsById[i].socket) {

                            this.socketsById[i].socket.json.send({ type: 'unsubscribe', project: projectId });
                        }
                    }
                }
            }
        }
    }
};


// Streamer message handler

internals.messageHandler = function (manager, socket) {

    return function (message) {

        var connection = manager.socketsById[socket.id];
        if (connection) {
            if (message) {
                switch (message.type) {
                    case 'initialize':
                        if (!message.authorization) {
                            socket.json.send({ type: 'initialize', status: 'error', error: 'Missing authorization' });
                        }
                        else {
                            Session.validateMessage(manager.env, socket.id, message.authorization, function (err, userId) {

                                if (userId) {
                                    connection.userId = userId;

                                    manager.idsByUserId[userId] = manager.idsByUserId[userId] || {};
                                    manager.idsByUserId[userId][socket.id] = true;

                                    socket.json.send({ type: 'initialize', status: 'ok', user: userId });
                                }
                                else {
                                    socket.json.send({ type: 'initialize', status: 'error', error: err });
                                }
                            });
                        }
                        break;

                    default:
                        socket.json.send({ type: 'error', error: 'Unknown message type: ' + message.type });
                        break;
                }
            }
        }
        else {
            // Message received after disconnect from socket
        }
    };
};


// Streamer disconnection handler

internals.disconnectHandler = function (manager, socket) {

    return function () {

        if (manager.socketsById[socket.id]) {
            var userId = manager.socketsById[socket.id].userId;

            // Remove from users list

            if (userId) {
                delete manager.idsByUserId[userId];
            }

            // Remove from sockets list

            delete manager.socketsById[socket.id];
        }

        // Remove from subscribers list

        var projects = manager.projectsById[socket.id];
        if (projects) {
            for (var i in projects) {
                if (projects.hasOwnProperty(i)) {
                    if (manager.idsByProject[i]) {
                        delete manager.idsByProject[i][socket.id];
                    }
                }
            }
        }

        // Remove from cleanup list

        delete manager.projectsById[socket.id];
    };
};

