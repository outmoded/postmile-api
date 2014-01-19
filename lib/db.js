// Load Modules

var MongoDB = require('mongodb');
var Hoek = require('hoek');
var Boom = require('boom');


// Declare internals

var internals = {
    collectionNames: ['client',
                       'invite',
                       'grant',
                       'project', 'project.sort',
                       'suggestion',
                       'task', 'task.details', 'task.sort',
                       'tip',
                       'user', 'user.exclude', 'user.last', 'user.storage']
};


module.exports = internals.Db = function (options) {

    this._settings = options.config;
    this._client = new MongoDB.Db(options.config.database.db, new MongoDB.Server(options.config.database.host, options.config.database.port, {}), { strict: true });
    this._collections = {};

    this.Long = this._client.bson_serializer.Long;
    this.ObjectID = this._client.bson_serializer.ObjectID;
};


internals.Db.prototype.initialize = function (arg1, arg2) {        // [isNew,] callback

    var self = this;

    var isNew = (arg2 ? arg1 : false);
    var callback = (arg2 || arg1);

    this._client.open(function (err, client) {

        if (err) {
            return callback('Database connection error: ' + JSON.stringify(err));
        }

        if (!self._settings.database.username) {
            return self.initCollection(0, isNew, callback);
        }

        self._client.authenticate(self._settings.database.username, self._settings.database.password, function (err, result) {

            if (err) {
                return callback('Database authentication error: ' + JSON.stringify(err));
            }

            if (!result) {
                return callback('Database authentication failed');
            }

            return self.initCollection(0, isNew, callback);
        });
    });

    // TODO: find a way to close the connection
};


internals.Db.prototype.initCollection = function (i, isNew, callback) {

    var self = this;

    var next = function (err, collection) {

        if (err) {
            return callback('Failed opening collection: ' + internals.collectionNames[i] + ' due to: ' + err);
        }

        self._collections[internals.collectionNames[i]] = collection;
        self.initCollection(i + 1, isNew, callback);
    };

    if (i >= internals.collectionNames.length) {
        return callback(null);
    }

    if (isNew) {
        return this._client.createCollection(internals.collectionNames[i], next);
    }

    return this._client.collection(internals.collectionNames[i], next);
};


// Get entire collection

internals.Db.prototype.all = function (collectionName, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'all'));
    }

    collection.find(function (err, cursor) {

        if (err) {
            return callback(internals.error(err, collectionName, 'all'));
        }

        cursor.toArray(function (err, results) {

            if (err) {
                return callback(internals.error(err, collectionName, 'all'));
            }

            self._normalize(results);
            return callback(null, results);
        });
    });
};


// Get document by id

internals.Db.prototype.get = function (collectionName, id, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'get', id));
    }

    var dbId = this._getDbId(id);
    if (!dbId) {
        return callback(null, null);
    }

    collection.findOne(dbId, function (err, result) {

        if (err) {
            return callback(internals.error(err, collectionName, 'get', id));
        }

        self._normalize(result);
        return callback(null, result);
    });
};


// Get multiple documents by id list

internals.Db.prototype.getMany = function (collectionName, ids, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'getMany', ids), ids);
    }

    var notFound = [];
    var criteria = { _id: {} };
    criteria._id.$in = [];
    for (var i = 0, il = ids.length; i < il; ++i) {
        var dbId = this._getDbId(ids[i]);
        if (dbId) {
            criteria._id.$in.push(dbId);
        }
        else {
            notFound.push(ids[i]);
        }
    }

    if (criteria._id.$in.length <= 0) {
        return callback(null, [], ids);
    }

    collection.find(criteria, function (err, cursor) {

        if (err) {
            return callback(internals.error(err, collectionName, 'getMany', ids), ids);
        }

        cursor.toArray(function (err, results) {

            if (err) {
                return callback(internals.error(err, collectionName, 'getMany', ids), ids);
            }

            if (results.length <= 0) {
                return callback(null, [], ids);
            }

            self._normalize(results);

            // Sort based on requested ids

            var map = {};
            for (i = 0, il = results.length; i < il; ++i) {
                map[results[i]._id] = results[i];
            }

            var items = [];
            for (i = 0, il = ids.length; i < il; ++i) {
                if (map[ids[i]]) {
                    items.push(map[ids[i]]);
                }
                else {
                    notFound.push(ids[i]);
                }
            }

            return callback(null, items, notFound);
        });
    });
};


// Query documents by criteria

internals.Db.prototype.query = function (collectionName, criteria, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'query', criteria));
    }

    this._idifyString(criteria);
    collection.find(criteria, function (err, cursor) {

        if (err) {
            return callback(internals.error(err, collectionName, 'query', criteria));
        }

        cursor.toArray(function (err, results) {

            if (err) {
                return callback(internals.error(err, collectionName, 'query', criteria));
            }

            self._normalize(results);
            return callback(null, results);
        });
    });
};


// Query for a single (unique) documents by criteria

internals.Db.prototype.queryUnique = function (collectionName, criteria, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'queryUnique', criteria));
    }

    this._idifyString(criteria);
    collection.find(criteria, function (err, cursor) {

        if (err) {
            return callback(internals.error(err, collectionName, 'queryUnique', criteria));
        }

        cursor.toArray(function (err, results) {

            if (err) {
                return callback(internals.error(err, collectionName, 'queryUnique', criteria));
            }

            if (!results) {
                return callback(internals.error('Null result array', collectionName, 'queryUnique', criteria));
            }

            if (results.length <= 0) {
                return callback(null, null);
            }

            if (results.length !== 1) {
                return callback(internals.error('Found multiple results for unique criteria', collectionName, 'queryUnique', criteria));
            }

            var result = results[0];
            self._normalize(result);
            return callback(null, result);
        });
    });
};


// Count documents by criteria

internals.Db.prototype.count = function (collectionName, criteria, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'count', criteria));
    }

    this._idifyString(criteria);
    collection.count(criteria, function (err, count) {

        if (err) {
            return callback(internals.error(err, collectionName, 'count', criteria));
        }

        return callback(null, count);
    });
};


// Save new documents (one or many)

internals.Db.prototype.insert = function (collectionName, items, callback) {

    var self = this;

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'insert', items));
    }

    var now = Date.now();

    if (items instanceof Array) {
        for (var i = 0, il = items.length; i < il; ++i) {
            items[i].created = now;
            items[i].modified = now;
        }
    }
    else {
        items.created = now;
        items.modified = now;
    }

    this._idifyString(items);
    collection.insert(items, function (err, results) {

        if (err) {
            return callback(internals.error(err, collectionName, 'insert', items));
        }

        if (!results ||
            results.length <= 0) {

            return callback(internals.error('No database insert output', collectionName, 'insert', items));
        }

        self._normalize(results);
        return callback(null, results);
    });
};


// Replace a single existing document

internals.Db.prototype.replace = function (collectionName, item, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'replace', item));
    }

    var now = Date.now();
    if (item.created === undefined) {

        item.created = now;
    }

    item.modified = now;

    this._idifyString(item);
    collection.update({ _id: item._id }, item, function (err, count) {

        if (err) {
            return callback(internals.error(err, collectionName, 'replace', item));
        }

        if (!count) {
            return callback(internals.error('No document found to replace', collectionName, 'replace', item));
        }

        return callback(null);
    });
};


// Update a single existing document

internals.Db.prototype.update = function (collectionName, id, changes, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'update', [id, changes]));
    }

    changes = changes || {};
    changes.$set = changes.$set || {};

    var now = Date.now();
    changes.$set.modified = now;

    var dbId = this._getDbId(id);
    if (!dbId) {
        return callback(internals.error('Invalid id', collectionName, 'update', [id, changes]));
    }

    collection.update({ _id: dbId }, changes, function (err, count) {

        if (err) {
            return callback(internals.error(err, collectionName, 'update', [id, changes]));
        }

        if (!count) {
            return callback(internals.error('No document found to update', collectionName, 'update', [id, changes]));
        }

        return callback(null);
    });
};


// Update any existing document matching criteria

internals.Db.prototype.updateCriteria = function (collectionName, id, itemCriteria, changes, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'updateCriteria', [id, itemCriteria, changes]));
    }

    changes = changes || {};
    changes.$set = changes.$set || {};

    var now = Date.now();
    changes.$set.modified = now;

    var isValid = true;

    // Add id to criteria if present

    var options = {};

    if (id) {
        var dbId = this._getDbId(id);
        if (dbId) {
            itemCriteria._id = dbId;
        }
        else {
            isValid = false;
        }
    }
    else {
        options.multi = true;
    }

    if (!isValid) {
        return callback(internals.error('Invalid id', collectionName, 'updateCriteria', [id, itemCriteria, changes, options]));
    }

    collection.update(itemCriteria, changes, options, function (err, count) {

        if (err) {
            return callback(internals.error(err, collectionName, 'updateCriteria', [id, itemCriteria, changes, options]));
        }

        if (!id) {
            return callback(null);
        }

        if (!count) {
            return callback(internals.error('No document found to update', collectionName, 'updateCriteria', [id, itemCriteria, changes, options]));
        }

        return callback(null);
    });
};


// Remove item

internals.Db.prototype.remove = function (collectionName, id, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'remove', id));
    }

    var dbId = new this.ObjectID(id);
    collection.remove({ _id: dbId }, function (err, collection) {

        if (err) {
            return callback(internals.error(err, collectionName, 'remove', id));
        }

        return callback(null);
    });
};


// Remove criteria

internals.Db.prototype.removeCriteria = function (collectionName, criteria, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'remove', id));
    }

    this._idifyString(criteria);
    collection.remove(criteria, function (err, collection) {

        if (err) {
            return callback(internals.error(err, collectionName, 'remove', id));
        }

        return callback(null);
    });
};


// Remove multiple items

internals.Db.prototype.removeMany = function (collectionName, ids, callback) {

    var collection = this._collections[collectionName];
    if (!collection) {
        return callback(internals.error('Collection not found', collectionName, 'remove', ids));
    }

    var criteria = { _id: {} };
    criteria._id.$in = [];
    for (var i = 0, il = ids.length; i < il; ++i) {
        var dbId = this._getDbId(ids[i]);
        if (dbId) {
            criteria._id.$in.push(dbId);
        }
    }

    if (criteria._id.$in.length <= 0) {
        return callback(internals.error('Invalid ids', collectionName, 'remove', ids));
    }

    collection.remove(criteria, function (err, collection) {

        if (err) {
            return callback(internals.error(err, collectionName, 'remove', ids));
        }

        return callback(null);
    });
};


// Convert object into update changes

internals.Db.prototype.toChanges = function (item) {

    var changes = {};

    if (item &&
        item instanceof Object &&
        item instanceof Array === false) {

        changes.$set = {};

        for (var i in item) {
            if (item.hasOwnProperty(i)) {
                changes.$set[i] = item[i];
            }
        }
    }

    return changes;
};


// Get unique identifier

internals.Db.prototype.generateId = function () {

    var id = new this.ObjectID();
    return id.toString();
};


// Encode key

internals.Db.prototype.encodeKey = function (value) {

    return value.replace(/%/g, '%25').replace(/\./g, '%2E').replace(/^\$/, '%24');
};


// Decode key

internals.Db.prototype.decodeKey = function (value) {

    return decodeURIComponent(value);
};


// Remove db specific id object type

internals.Db.prototype._normalize = function (obj) {

    if (obj !== null) {
        for (var i in obj) {
            if (obj.hasOwnProperty(i)) {
                if (obj[i] instanceof this.Long) {
                    obj[i] = obj[i].toNumber();
                }
                else if (obj[i] instanceof this.ObjectID) {
                    obj[i] = obj[i].toString();
                }
                else if (obj[i] && typeof obj[i] === 'object') {
                    this._normalize(obj[i]);
                }
            }
        }
    }
};


// Changed id into db specific object type

internals.Db.prototype._idifyString = function (items) {

    if (items) {
        if (items instanceof Array) {
            for (var i = 0, il = items.length; i < il; ++i) {
                if (items[i]._id) {
                    items[i]._id = new this.ObjectID(items[i]._id);
                }
            }
        }
        else {
            if (items._id) {
                items._id = new this.ObjectID(items._id);
            }
        }
    }
};


// Get DB id

internals.Db.prototype._getDbId = function (id) {

    if (/^[0-9a-fA-F]{24}$/.test(id)) {
        return new this.ObjectID(id);
    }
    else {
        return null;
    }
};


// Construct error artifact

internals.error = function (error, collection, action, input) {

    return Boom.internal('Database error', { error: error, collection: collection, action: action, input: input });
};

