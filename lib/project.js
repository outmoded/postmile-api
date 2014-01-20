// Load modules

var Hapi = require('hapi');
var User = require('./user');
var Tips = require('./tips');
var Suggestions = require('./suggestions');
var Sort = require('./sort');
var Task = require('./task');
var Email = require('./email');
var Last = require('./last');
var Utils = require('./utils');


// Declare internals

var internals = {};


// Get project information

exports.get = {

    handler: function (request, reply) {

        var self = this;

        exports.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            internals.participantsList(self.db, project, function (participants) {

                project.participants = participants;
                return reply(project);
            });
        });
    }
};


// Get list of projects for current user

exports.list = {
    handler: function (request, reply) {

        var self = this;

        Sort.list(this.db, 'project', request.auth.credentials.user, 'participants.id', function (err, projects) {

            if (err || !projects) {
                return reply(Hapi.Error.notFound());
            }

            var list = [];
            for (var i = 0, il = projects.length; i < il; ++i) {
                var isPending = false;
                for (var p = 0, pl = projects[i].participants.length; p < pl; ++p) {
                    if (projects[i].participants[p].id &&
                        projects[i].participants[p].id === request.auth.credentials.user) {

                        isPending = projects[i].participants[p].isPending || false;
                        break;
                    }
                }

                var item = { id: projects[i]._id, title: projects[i].title };

                if (isPending) {
                    item.isPending = true;
                }

                list.push(item);
            }

            Last.load(self.db, request.auth.credentials.user, function (err, last) {

                if (last &&
                    last.projects) {

                    for (i = 0, il = list.length; i < il; ++i) {
                        if (last.projects[list[i].id]) {
                            list[i].last = last.projects[list[i].id].last;
                        }
                    }
                }

                return reply(list);
            });
        });
    }
};


// Update project properties

exports.post = {
    validate: {
        query: {
            position: Hapi.types.Number().min(0)
        },
        payload: {
            title: Hapi.types.String(),
            date: Hapi.types.String().regex(Utils.dateRegex).emptyOk(),
            time: Hapi.types.String().regex(Utils.timeRegex).emptyOk(),
            place: Hapi.types.String().emptyOk()
        }
    },
    handler: function (request, reply) {

        var self = this;

        exports.load(this.db, request.params.id, request.auth.credentials.user, true, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            if (Object.keys(request.payload).length > 0) {
                if (request.query.position) {
                    return reply(Hapi.Error.badRequest('Cannot include both position parameter and project object in body'));
                }

                self.db.update('project', project._id, self.db.toChanges(request.payload), function (err) {

                    if (err) {
                        return reply(err);
                    }

                    self.streamer.update({ object: 'project', project: project._id }, request);

                    if (request.payload.title !== project.title) {
                        for (var i = 0, il = project.participants.length; i < il; ++i) {
                            if (project.participants[i].id) {
                                self.streamer.update({ object: 'projects', user: project.participants[i].id }, request);
                            }
                        }
                    }

                    return reply({ status: 'ok' });
                });
            }
            else if (request.query.position) {
                Sort.set(self.db, 'project', request.auth.credentials.user, 'participants.id', request.params.id, request.query.position, function (err) {

                    if (err) {
                        return reply(err);
                    }

                    self.streamer.update({ object: 'projects', user: request.auth.credentials.user }, request);
                    return reply({ status: 'ok' });
                });
            }
            else {
                return reply(Hapi.Error.badRequest('Missing position parameter or project object in body'));
            }
        });
    }
};


// Create new project

exports.put = {
    validate: {
        payload: {
            title: Hapi.types.String().required(),
            date: Hapi.types.String().regex(Utils.dateRegex).emptyOk(),
            time: Hapi.types.String().regex(Utils.timeRegex).emptyOk(),
            place: Hapi.types.String().emptyOk()
        }
    },
    handler: function (request, reply) {

        var self = this;

        var project = request.payload;
        project.participants = [{ id: request.auth.credentials.user }];
        this.db.insert('project', project, function (err, items) {

            if (err) {
                return reply(err);
            }

            self.streamer.update({ object: 'projects', user: request.auth.credentials.user }, request);
            return reply({ status: 'ok', id: items[0]._id })
                          .created('project/' + items[0]._id);
        });
    }
};


// Delete a project

exports.del = {
    handler: function (request, reply) {

        var self = this;

        exports.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            // Check if owner

            if (exports.isOwner(project, request.auth.credentials.user)) {

                // Delete all tasks

                Task.delProject(self.db, project._id, function (err) {

                    if (err) {
                        return reply(err);
                    }

                    // Delete project

                    self.db.remove('project', project._id, function (err) {

                        if (err) {
                            return reply(err);
                        }

                        Last.delProject(self.db, request.auth.credentials.user, project._id, function (err) { });
                        self.streamer.update({ object: 'project', project: project._id }, request);

                        for (var i = 0, il = project.participants.length; i < il; ++i) {
                            if (project.participants[i].id) {
                                self.streamer.update({ object: 'projects', user: project.participants[i].id }, request);
                                self.streamer.drop(project.participants[i].id, project._id);
                            }
                        }

                        return reply({ status: 'ok' });
                    });
                });
            }
            else {

                // Leave project

                internals.leave(self.db, project, member, function (err) {

                    if (err) {
                        return reply(err);
                    }

                    self.streamer.update({ object: 'project', project: project._id }, request);
                    self.streamer.update({ object: 'projects', user: request.auth.credentials.user }, request);
                    self.streamer.drop(request.auth.credentials.user, project._id);

                    return reply({ status: 'ok' });
                });
            }
        });
    }
};


// Get list of project tips

exports.tips = {
    handler: function (request, reply) {

        var self = this;

        // Get project

        exports.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            // Collect tips

            Tips.list(self.db, project, function (results) {

                return reply(results);
            });
        });
    }
};


// Get list of project suggestions

exports.suggestions = {
    handler: function (request, reply) {

        var self = this;

        // Get project

        exports.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            // Collect tips

            Suggestions.list(self.db, project, request.auth.credentials.user, function (err, results) {

                return reply(err || results);
            });
        });
    }
};


// Add new participants to a project

exports.participants = {
    validate: {
        query: {
            message: Hapi.types.String().max(250)
        },
        payload: {
            participants: Hapi.types.Array().includes(Hapi.types.String()),     //!! ids or emails
            names: Hapi.types.Array().includes(Hapi.types.String())
        }
    },
    handler: function (request, reply) {

        var self = this;

        var add = function () {

            if (!request.query.message) {
                return process();
            }

            if (request.query.message.match('://')) {
                return reply(Hapi.Error.badRequest('Message cannot contain links'));
            }

            return process();
        };

        var process = function () {

            if (!request.payload.participants &&
                !request.payload.names) {

                return reply(Hapi.Error.badRequest('Body must contain a participants or names array'));
            }

            exports.load(self.db, request.params.id, request.auth.credentials.user, true, function (err, project, member) {

                if (err || !project) {
                    return reply(err);
                }

                var change = { $pushAll: { participants: [] } };

                // Add pids (non-users)

                if (request.payload.names) {
                    for (var i = 0, il = request.payload.names.length; i < il; ++i) {
                        var participant = { pid: self.db.generateId(), display: request.payload.names[i] };
                        change.$pushAll.participants.push(participant);
                    }

                    if (!request.payload.participants) {

                        // No user accounts to invite, save project

                        self.db.update('project', project._id, change, function (err) {

                            if (err) {
                                return reply(err);
                            }

                            // Return success

                            finalize();
                        });
                    }
                }

                // Add users or emails

                if (request.payload.participants) {

                    // Get user

                    User.load(self.db, request.auth.credentials.user, function (err, user) {

                        if (err || !user) {
                            return reply(err);
                        }

                        // Lookup existing users

                        User.find(self.db, request.payload.participants, function (err, users, emailsNotFound) {

                            if (err) {
                                return reply(err);
                            }

                            var prevParticipants = Hapi.utils.mapToObject(project.participants, 'id');

                            // Check for changes

                            var contactsChange = { $set: {} };
                            var now = Date.now();

                            var changedUsers = [];
                            for (var i = 0, il = users.length; i < il; ++i) {

                                // Add / update contact

                                if (users[i]._id !== request.auth.credentials.user) {
                                    contactsChange.$set['contacts.' + users[i]._id] = { type: 'user', last: now };
                                }

                                // Add participant if new

                                if (prevParticipants[users[i]._id] !== true) {
                                    change.$pushAll.participants.push({ id: users[i]._id, isPending: true });
                                    changedUsers.push(users[i]);
                                }
                            }

                            var prevPids = Hapi.utils.mapToObject(project.participants, 'email');

                            var pids = [];
                            for (i = 0, il = emailsNotFound.length; i < il; ++i) {
                                contactsChange.$set['contacts.' + self.db.encodeKey(emailsNotFound[i])] = { type: 'email', last: now };

                                if (prevPids[emailsNotFound[i]] !== true) {
                                    var pid = {
                                        pid: self.db.generateId(),
                                        display: emailsNotFound[i],
                                        isPending: true,

                                        // Internal fields

                                        email: emailsNotFound[i],
                                        code: Utils.getRandomString(6),
                                        inviter: user._id
                                    };

                                    change.$pushAll.participants.push(pid);
                                    pids.push(pid);
                                }
                            }

                            // Update user contacts

                            if (Object.keys(contactsChange.$set).length > 0) {
                                self.db.update('user', user._id, contactsChange, function (err) {

                                    // Non-blocking

                                    if (!err) {
                                        self.streamer.update({ object: 'contacts', user: user._id }, request);
                                    }
                                });
                            }

                            // Update project participants

                            if (change.$pushAll.participants.length <= 0) {
                                return reply(Hapi.Error.badRequest('All users are already project participants'));
                            }

                            self.db.update('project', project._id, change, function (err) {

                                if (err) {
                                    return reply(err);
                                }

                                for (var i = 0, il = changedUsers.length; i < il; ++i) {
                                    self.streamer.update({ object: 'projects', user: changedUsers[i]._id }, request);
                                }

                                // Invite new participants

                                Email.projectInvite(self, changedUsers, pids, project, request.query.message, user);

                                // Return success

                                finalize();
                            });
                        });
                    });
                }
            });
        };

        finalize = function () {

            self.streamer.update({ object: 'project', project: request.params.id }, request);

            // Reload project (changed, use direct DB to skip load processing)

            self.db.get('project', request.params.id, function (err, project) {

                if (err || !project) {
                    return reply(err);
                }

                internals.participantsList(self.db, project, function (participants) {

                    var response = { status: 'ok', participants: participants };
                    return reply(response);
                });
            });
        };

        add();
    }
};


// Remove participant from project

exports.uninvite = {
    validate: {
        payload: {
            participants: Hapi.types.Array().required().includes(Hapi.types.String())
        }
    },
    handler: function (request, reply) {

        var self = this;

        var uninvite = function () {

            // Load project for write

            exports.load(self.db, request.params.id, request.auth.credentials.user, true, function (err, project, member) {

                if (err || !project) {
                    return reply(err);
                }

                // Check if owner

                if (!exports.isOwner(project, request.auth.credentials.user)) {
                    return reply(Hapi.Error.badRequest('Not an owner'));
                }

                // Check if single delete or batch

                if (request.params.user) {

                    // Single delete

                    if (request.auth.credentials.user === request.params.user) {
                        return reply(Hapi.Error.badRequest('Cannot uninvite self'));
                    }

                    // Lookup user

                    var uninvitedMember = exports.getMember(project, request.params.user);
                    if (!uninvitedMember) {
                        return reply(Hapi.Error.notFound('Not a project participant'));
                    }

                    internals.leave(self.db, project, uninvitedMember, function (err) {

                        if (err) {
                            return reply(err);
                        }

                        // Return success

                        self.streamer.update({ object: 'projects', user: request.params.user }, request);
                        self.streamer.drop(request.params.user, project._id);
                        finalize();
                    });
                }
                else if (request.payload.participants) {

                    // Batch delete

                    var error = null;
                    var uninvitedMembers = [];

                    for (var i = 0, il = request.payload.participants.length; i < il; ++i) {
                        var removeId = request.payload.participants[i];

                        if (request.auth.credentials.user === removeId) {
                            error = Hapi.Error.badRequest('Cannot uninvite self');
                            break;
                        }

                        // Lookup user

                        var uninvited = exports.getMember(project, removeId);
                        if (!uninvited) {
                            error = Hapi.Error.notFound('Not a project participant: ' + removeId);
                            break;
                        }
                        uninvitedMembers.push(uninvited);
                    }

                    if (uninvitedMembers.length === 0) {
                        error = Hapi.Error.badRequest('No members to remove');
                    }

                    if (error) {
                        return reply(error);
                    }

                    // Batch leave

                    batch(project, uninvitedMembers, 0, function (err) {

                        if (err) {
                            return reply(err);
                        }

                        // Return success

                        finalize();
                    });
                }
                else {
                    return reply(Hapi.Error.badRequest('No participant for removal included'));
                }
            });
        };

        var batch = function (project, members, pos, callback) {

            if (pos >= members.length) {
                return callback(null);
            }

            internals.leave(self.db, project, members[pos], function (err) {

                if (err) {
                    return callback(err);
                }

                // Return success

                if (members[pos].id) {
                    self.streamer.update({ object: 'projects', user: members[pos].id }, request);
                    self.streamer.drop(members[pos].id, project._id);
                }

                return batch(project, members, pos + 1, callback);
            });
        };

        var finalize = function () {

            self.streamer.update({ object: 'project', project: request.params.id }, request);

            // Reload project (changed, use direct DB to skip load processing)

            self.db.get('project', request.params.id, function (err, project) {

                if (err || !project) {
                    return reply(err);
                }

                internals.participantsList(self.db, project, function (participants) {

                    var response = { status: 'ok', participants: participants };
                    return reply(response);
                });
            });
        };

        uninvite();
    }
};


// Accept project invitation

exports.join = {
    handler: function (request, reply) {

        var self = this;

        // The only place allowed to request a non-writable copy for modification
        exports.load(this.db, request.params.id, request.auth.credentials.user, false, function (err, project, member) {

            if (err || !project) {
                return reply(err);
            }

            // Verify user is pending

            if (!member.isPending) {
                return reply(Hapi.Error.badRequest('Already a member of the project'));
            }

            self.db.updateCriteria('project', project._id, { 'participants.id': request.auth.credentials.user }, { $unset: { 'participants.$.isPending': 1 } }, function (err) {

                if (err) {
                    return reply(err);
                }

                // Return success

                self.streamer.update({ object: 'project', project: project._id }, request);
                self.streamer.update({ object: 'projects', user: request.auth.credentials.user }, request);

                return reply({ status: 'ok' });
            });
        });
    }
};


// Load project from database and check for user rights

exports.load = function (db, projectId, userId, isWritable, callback) {

    db.get('project', projectId, function (err, item) {

        if (!item) {
            return callback(err || Hapi.Error.notFound());
        }

        var member = null;
        for (var i = 0, il = item.participants.length; i < il; ++i) {
            if (item.participants[i].id &&
                item.participants[i].id === userId) {

                member = item.participants[i];
                if (member.isPending) {
                    item.isPending = true;
                }

                break;
            }
        }

        if (!member) {
            return callback(Hapi.Error.forbidden('Not a project member'));
        }

        if (isWritable &&
            item.isPending) {

            return callback(Hapi.Error.forbidden('Must accept project invitation before making changes'));
        }

        return callback(null, item, member);
    });
};


// Get participants list

internals.participantsList = function (db, project, callback) {

    var userIds = [];
    for (var i = 0, il = project.participants.length; i < il; ++i) {
        if (project.participants[i].id) {
            userIds.push(project.participants[i].id);
        }
    }

    User.expandIds(db, userIds, function (users, usersMap) {

        var participants = [];
        for (var i = 0, il = project.participants.length; i < il; ++i) {

            var participant = null;
            if (project.participants[i].id) {

                // Registered user participant

                participant = usersMap[project.participants[i].id];
            }
            else if (project.participants[i].pid) {

                // Non-user participant

                participant = {
                    id: 'pid:' + project.participants[i].pid,
                    display: project.participants[i].display,
                    isPid: true
                };
            }

            if (participant) {
                if (project.participants[i].isPending) {
                    participant.isPending = project.participants[i].isPending;
                }

                participants.push(participant);
            }
        }

        return callback(participants);
    });
};


// Get participants map

exports.participantsMap = function (project) {

    var participants = { users: {}, emails: {} };
    for (var i = 0, il = project.participants.length; i < il; ++i) {
        if (project.participants[i].id) {

            // Registered user participant

            participants.users[project.participants[i].id] = true;
        }
        else if (project.participants[i].email) {

            // Non-user email-invited participant

            participants.emails[project.participants[i].email] = true;
        }
    }

    return participants;
};


// Get member

exports.getMember = function (project, userId) {

    var isPid = userId.indexOf('pid:') === 0;
    if (isPid) {
        userId = userId.substring(4);           // Remove 'pid:' prefix
    }

    for (var i = 0, il = project.participants.length; i < il; ++i) {
        if (isPid &&
            project.participants[i].pid &&
            project.participants[i].pid === userId) {

            return project.participants[i];
        }
        else if (project.participants[i].id &&
                 project.participants[i].id === userId) {

            return project.participants[i];
        }
    }

    return null;
};


// Check if member

exports.isMember = function (project, userId) {

    return (exports.getMember(project, userId) !== null);
};


// Check if owner

exports.isOwner = function (project, userId) {

    return (project.participants[0].id && project.participants[0].id === userId);
};


// Leave project

internals.leave = function (db, project, member, callback) {

    var isPid = (member.pid !== null && member.pid !== undefined);
    var userId = (isPid ? member.pid : member.id);

    // Check if user is assigned tasks

    Task.userTaskList(db, project._id, (isPid ? 'pid:' + userId : userId), function (err, tasks) {

        if (err) {
            return callback(err);
        }

        if (tasks.length > 0) {

            // Check if removing a pid

            if (isPid === false) {

                // Load user

                User.load(db, userId, function (err, user) {

                    if (err || !user) {
                        return callback(err);
                    }

                    // Add unregistered project account (pid)

                    var display = (user.name ? user.name
                                             : (user.username ? user.username
                                                              : (user.emails && user.emails[0] && user.emails[0].address ? user.emails[0].address : null)));

                    var participant = { pid: db.generateId(), display: display };

                    // Move any assignments to pid account (not details) and save tasks

                    var taskCriteria = { project: project._id, participants: userId };
                    var taskChange = { $set: { 'participants.$': 'pid:' + participant.pid } };
                    db.updateCriteria('task', null, taskCriteria, taskChange, function (err) {

                        if (err) {
                            return callback(err);
                        }

                        // Save project

                        db.updateCriteria('project', project._id, { 'participants.id': userId }, { $set: { 'participants.$': participant } }, function (err) {

                            if (err) {
                                return callback(err);
                            }

                            // Cleanup last information

                            Last.delProject(db, userId, project._id, function (err) { });
                            return callback(null);
                        });
                    });
                });
            }
            else {

                // Remove pid

                if (!member.isPending) {
                    return callback(Hapi.Error.badRequest('Cannot remove pid user with task assignments'));
                }

                // Remove invitation from pid

                var participant = { pid: member.pid, display: member.display };
                db.updateCriteria('project', project._id, { 'participants.pid': userId }, { $set: { 'participants.$': participant } }, function (err) {

                    return callback(err);
                });
            }
        }
        else {

            var change = { $pull: { participants: {} } };
            change.$pull.participants[isPid ? 'pid' : 'id'] = userId;

            db.update('project', project._id, change, function (err) {

                if (err) {
                    return callback(err);
                }

                if (isPid === false) {

                    // Cleanup last information

                    Last.delProject(db, userId, project._id, function (err) { });
                }

                return callback(null);
            });
        }
    });
};


// Replace pid with actual user

exports.replacePid = function (db, project, pid, userId, callback) {

    // Move any assignments to pid account (not details) and save tasks

    var taskCriteria = { project: project._id, participants: 'pid:' + pid };
    var taskChange = { $set: { 'participants.$': userId } };
    db.updateCriteria('task', null, taskCriteria, taskChange, function (err) {

        if (err) {
            return callback(err);
        }

        // Check if user already a member

        if (exports.isMember(project, userId)) {

            // Remove Pid without adding

            db.update('project', project._id, { $pull: { participants: { pid: pid } } }, function (err) {

                return callback(err);
            });
        }
        else {

            // Replace pid with user

            db.updateCriteria('project', project._id, { 'participants.pid': pid }, { $set: { 'participants.$': { id: userId } } }, function (err) {

                return callback(err);
            });
        }
    });
};


// Unsorted list

exports.unsortedList = function (db, userId, callback) {

    db.query('project', { 'participants.id': request.auth.credentials.user }, function (err, projects) {

        if (err) {
            return callback(err);
        }

        if (projects.length <= 0) {
            return callback(null, [], [], []);
        }

        var owner = [];
        var notOwner = [];
        for (var i = 0, il = projects.length; i < il; ++i) {
            for (var p = 0, pl = projects[i].participants.length; p < pl; ++p) {
                if (projects[i].participants[p].id &&
                    projects[i].participants[p].id === request.auth.credentials.user) {

                    projects[i]._isPending = projects[i].participants[p].isPending || false;

                    if (i == 0) {
                        projects[i]._isOwner = true;
                        owner.push(projects[i]);
                    }
                    else {
                        projects[i]._isOwner = false;
                        notOwner.push(projects[i]);
                    }

                    break;
                }
            }
        }

        return callback(null, projects, owner, notOwner);
    });
};


// Delete an empty project (verified by caller)

exports.delEmpty = function (db, projectId, callback) {

    // Delete all tasks

    Task.delProject(projectId, function (err) {

        if (err) {
            return callback(err);
        }

        // Delete project

        db.remove('project', project._id, function (err) {

            return callback(err);
        });
    });
};


