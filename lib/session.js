// Load modules

var Hapi = require('hapi');
var Oz = require('oz');
var Crypto = require('crypto');
var User = require('./user');
var Email = require('./email');


// Declare internals

var internals = {};


// Get application information endpoint

exports.app = {
    auth: {
        scope: 'login',
        entity: 'app'
    },
    handler: function (request, reply) {

        this.db.queryUnique('client', { name: request.params.id }, function (err, client) {

            if (err) {
                return reply(err);
            }

            if (!client) {
                return reply(Hapi.Error.notFound());
            }

            Hapi.utils.removeKeys(client, ['algorithm', 'key', 'scope']);
            return reply(client);
        });
    }
};


exports.login = {
    validate: {
        payload: {
            type: Hapi.types.String().valid('id', 'twitter', 'facebook', 'yahoo', 'email').required(),
            id: Hapi.types.String().required(),
            issueTo: Hapi.types.String()
        }
    },
    auth: {
        scope: 'login',
        entity: 'app'
    },
    handler: function (request, reply) {

        var self = this;

        var type = request.payload.type;
        var id = request.payload.id;

        var loadUser = function () {

            if (type === 'id') {
                User.load(self.db, id, function (err, user) {

                    if (err) {
                        return reply(Hapi.Error.unauthorized(err.message));
                    }

                    loadGrant(user);
                });
            }
            else if (type === 'email') {
                Email.loadTicket(self, id, function (err, emailTicket, user) {

                    if (err) {
                        return reply(Hapi.Error.unauthorized(err.message));
                    }

                    loadGrant(user, { 'action': emailTicket.action });
                });
            }
            else {
                
                // twitter, facebook, yahoo

                User.validate(self.db, id, type, function (err, user) {

                    if (err || !user) {
                        return reply(Hapi.Error.unauthorized());
                    }

                    loadGrant(user);
                });
            }
        };

        var loadGrant = function (user, ext) {

            // Lookup existing grant

            var now = Date.now();

            var appId = request.payload.issueTo || request.auth.credentials.app;
            self.db.query('grant', { user: user.id, app: appId }, function (err, items) {

                if (err) {
                    return reply(err);
                }

                if (items &&
                    items.length > 0) {

                    items.sort(function (a, b) {

                        if (a.exp < b.exp) {
                            return -1;
                        }

                        if (a.exp > b.exp) {
                            return 1;
                        }

                        return 0;
                    });

                    var grant = null;

                    var expired = [];
                    for (var i = 0, il = items.length; i < il; ++i) {
                        if ((items[i].exp || 0) <= now) {
                            expired.push(items[i]._id);
                        }
                        else {
                            grant = items[i];
                        }
                    }

                    if (expired.length > 0) {
                        self.db.removeMany('grant', expired, function (err) { });         // Ignore callback
                    }

                    if (grant) {
                        return issue(appId, grant._id, ext);
                    }
                }

                // No active grant

                var newGrant = {
                    user: user._id,
                    app: appId,
                    exp: now + 30 * 24 * 60 * 60 * 1000,                        // 30 days //////////////////
                    scope: []                                                   // Find app scope ////////////
                };

                self.db.insert('grant', newGrant, function (err, items) {

                    if (err) {
                        return reply(err);
                    }

                    if (items.length !== 1 ||
                        !items[0]._id) {

                        return reply(Hapi.Error.internal('Failed to add new grant'));
                    }

                    return issue(appId, items[0]._id, ext);
                });
            });
        };

        var issue = function (appId, grantId, ext) {

            Oz.ticket.rsvp({ id: appId }, { id: grantId }, self.vault.ozTicket.password, {}, function (err, rsvp) {

                if (err) {
                    return reply(Hapi.Error.internal('Failed generating rsvp: ' + err));
                }

                var response = {
                    rsvp: rsvp
                };

                if (ext) {
                    response.ext = ext;
                }

                return reply(response);
            });
        };

        loadUser();
    }
};


exports.loadApp = function (db) {

    return function (id, callback) {

        if (!id) {
            return callback(Hapi.error.internal('Missing client id'));
        }

        db.get('client', id, function (err, client) {

            if (err || !client) {
                return callback(err || Hapi.error.unauthorized('Unknown client'));
            }

            var app = {
                id: client._id,
                key: client.key,
                scope: client.scope,
                algorithm: client.algorithm
            };

            return callback(null, app);
        });
    };
};


exports.loadGrant = function (db) {

    return function (grantId, callback) {

        db.get('grant', grantId, function (err, item) {

            // Verify grant is still valid

            if (err || !item) {
                return callback(err || Hapi.error.unauthorized('Unknown grant'));
            }

            User.load(db, item.user, function (err, user) {

                if (err || !user) {
                    callback(err || Hapi.error.unauthorized('Invalid grant'));
                }

                var result = {
                    id: item._id,
                    app: item.app,
                    user: item.user,
                    exp: item.exp,
                    scope: item.scope
                };

                var ext = {
                    tos: internals.getLatestTOS(user)
                };

                return callback(null, result, ext);
            });
        });
    };
};


// Validate message

exports.validateMessage = function (env, message, authorization, callback) {

    var credentialsFunc = Oz.server.credentialsFunc(env.vault.ozTicket.password, {});
    Oz.hawk.server.authenticateMessage(env.config.server.api.host, env.config.server.api.port, message, authorization, credentialsFunc, {}, function (err, credentials) {

        if (err) {
            return callback(Hapi.Error.notFound('Invalid ticket'));
        }
       
        return callback(null, credentials.user);
    });
};


// Remove all user grants

exports.delUser = function (db, userId, callback) {

    callback(null);
};


// Find latest accepted TOS

internals.getLatestTOS = function (user) {

    if (user &&
        user.tos &&
        typeof user.tos === 'object') {

        var versions = Object.keys(user.tos);
        if (versions.length > 0) {
            versions.sort();
            return versions[versions.length - 1];
        }
    }

    return 0;
};

