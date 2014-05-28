// Load modules

var Boom = require('boom');
var Joi = require('joi');


// Declare internals

var internals = {};


// User client data

exports.get = {
    handler: function (request, reply) {

        internals.load(this.db, request.auth.credentials.user, function (err, storage) {

            if (err) {
                return reply(err);
            }

            if (!storage ||
                !storage.clients ||
                !storage.clients[request.auth.credentials.app]) {

                if (request.params.id) {
                    return reply(Boom.notFound());
                }

                return reply({});
            }

            if (!request.params.id) {
                return reply(storage.clients[request.auth.credentials.app]);
            }

            if (!internals.checkKey(request.params.id)) {
                return reply(Boom.badRequest('Invalid key'));
            }

            if (!storage.clients[request.auth.credentials.app][request.params.id]) {
                return reply(Boom.notFound());
            }

            var result = {};
            result[request.params.id] = storage.clients[request.auth.credentials.app][request.params.id];
            return reply(result);
        });
    }
};


// Set user client data

exports.post = {
    validate: {
        payload: {
            value: Joi.string().required()
        }
    },
    handler: function (request, reply) {

        var self = this;

        if (!internals.checkKey(request.params.id)) {
            return reply(Boom.badRequest('Invalid key'));
        }

        internals.load(this.db, request.auth.credentials.user, function (err, storage) {

            if (err) {
                return reply(err);
            }

            if (storage) {

                // Existing storage

                var changes = { $set: {} };
                if (storage.clients) {
                    if (storage.clients[request.auth.credentials.app]) {
                        changes.$set['clients.' + request.auth.credentials.app + '.' + request.params.id] = request.payload.value;
                    }
                    else {
                        changes.$set['clients.' + request.auth.credentials.app] = {};
                        changes.$set['clients.' + request.auth.credentials.app][request.params.id] = request.payload.value;
                    }
                }
                else {
                    changes.$set.clients = {};
                    changes.$set.clients[request.auth.credentials.app] = {};
                    changes.$set.clients[request.auth.credentials.app][request.params.id] = request.payload.value;
                }

                self.db.update('user.storage', storage._id, changes, function (err) {

                    return reply(err || { status: 'ok' });
                });
            }
            else {

                // First client data

                storage = { _id: request.auth.credentials.user, clients: {} };
                storage.clients[request.auth.credentials.app] = {};
                storage.clients[request.auth.credentials.app][request.params.id] = request.payload.value;

                self.db.insert('user.storage', storage, function (err, items) {

                    return reply(err || { status: 'ok' });
                });
            }
        });
    }
};


// Delete user client data

exports.del = {
    handler: function (request, reply) {

        var self = this;

        if (!internals.checkKey(request.params.id)) {
            return reply(Boom.badRequest('Invalid key'));
        }

        internals.load(this.db, request.auth.credentials.user, function (err, storage) {

            if (err) {
                return reply(err);
            }

            if (!storage) {
                return reply(Boom.notFound());
            }

            if (!storage ||
                !storage.clients ||
                !storage.clients[request.auth.credentials.app] ||
                !storage.clients[request.auth.credentials.app][request.params.id]) {

                return reply(Boom.notFound());
            }

            var changes = { $unset: {} };
            changes.$unset['clients.' + request.auth.credentials.app + '.' + request.params.id] = 1;

            self.db.update('user.storage', storage._id, changes, function (err) {

                return reply(err || { status: 'ok' });
            });
        });
    }
};


// Load user last timestamps

internals.load = function (db, userId, callback) {

    db.get('user.storage', userId, function (err, item) {

        if (err) {
            return callback(err);
        }

        if (!item) {
            return callback(null, null);
        }

        return callback(null, item);
    });
};


// Check key

internals.checkKey = function (key) {

    var keyRegex = /^\w+$/;
    return (key.match(keyRegex) !== null);
};


// Remove entire storage record

exports.delUser = function (db, userId, callback) {

    db.remove('user.storage', userId, callback);
};

