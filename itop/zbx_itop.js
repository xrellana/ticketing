var DEFAULT_SEVERITY_MAP = {
    '5': {impact: '1', urgency: 'critical'},
    '4': {impact: '1', urgency: 'high'},
    '3': {impact: '2', urgency: 'medium'},
    '2': {impact: '3', urgency: 'low'},
    '1': {impact: '3', urgency: 'low'},
    '0': {impact: '3', urgency: 'low'}
};

function isObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}

function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
}

function isUnresolvedMacro(value) {
    return typeof value === 'string' && /^\{[A-Z][A-Z0-9_.]*(?:\.[A-Z0-9_:"\\ .-]+)*\}$/.test(value);
}

function hasValue(value) {
    return typeof value !== 'undefined' && value !== null && String(value) !== '' && !isUnresolvedMacro(value);
}

function getParam(params, name, defaultValue) {
    return hasValue(params[name]) ? params[name] : defaultValue;
}

function parseBoolean(value, defaultValue) {
    if (!hasValue(value)) {
        return defaultValue;
    }

    value = trim(value).toLowerCase();

    if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
        return true;
    }

    if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
        return false;
    }

    throw 'Incorrect boolean parameter value: ' + value;
}

function parseJSONParam(params, name, defaultValue) {
    var value = params[name];

    if (!hasValue(value)) {
        return defaultValue;
    }

    try {
        return JSON.parse(value);
    }
    catch (error) {
        throw 'Failed to parse JSON parameter "' + name + '": ' + error;
    }
}

function parseCSV(value) {
    var items = [],
        rawItems,
        i,
        item;

    if (!hasValue(value)) {
        return items;
    }

    rawItems = String(value).split(',');

    for (i = 0; i < rawItems.length; i++) {
        item = rawItems[i].replace(/^\s+|\s+$/g, '');

        if (item !== '') {
            items.push(item);
        }
    }

    return items;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function textToHtml(value) {
    return escapeHtml(value).replace(/(?:\r\n|\r|\n)/g, '<br>');
}

function trim(value) {
    return String(value).replace(/^\s+|\s+$/g, '');
}

function setFieldIfValue(fields, name, value) {
    if (hasValue(value)) {
        fields[name] = value;
    }
}

function mergeFields(target, source) {
    var key;

    if (!isObject(source)) {
        return target;
    }

    Object.keys(source).forEach(function (sourceKey) {
        key = sourceKey;

        if (hasValue(source[key]) || isObject(source[key]) || isArray(source[key])) {
            target[key] = source[key];
        }
    });

    return target;
}

function hasFields(fields) {
    return isObject(fields) && Object.keys(fields).length > 0;
}

function parseEventTags(rawParams) {
    var tags = {},
        eventTags = parseJSONParam(rawParams, 'event_tags_json', []),
        i,
        tagName;

    if (!isArray(eventTags)) {
        return tags;
    }

    for (i = 0; i < eventTags.length; i++) {
        if (isObject(eventTags[i])) {
            tagName = eventTags[i].tag || eventTags[i].name;

            if (hasValue(tagName)) {
                tags[tagName] = hasValue(eventTags[i].value) ? eventTags[i].value : '';
            }
        }
    }

    return tags;
}

function getTagValue(tags, tagName) {
    if (!hasValue(tagName)) {
        return '';
    }

    return hasValue(tags[tagName]) ? tags[tagName] : '';
}

function getParamOrTag(itopParams, tags, paramName, defaultTagName) {
    var value = itopParams[paramName],
        tagName = getParam(itopParams, paramName + '_tag', defaultTagName);

    if (hasValue(value)) {
        return value;
    }

    return getTagValue(tags, tagName);
}

function buildCaseLog(message, logFormat) {
    return {
        add_item: {
            message: message,
            format: logFormat
        }
    };
}

function buildPriorityFields(rawParams, itopParams, tags) {
    var fields = {},
        severityMap = parseJSONParam(itopParams, 'severity_map', DEFAULT_SEVERITY_MAP),
        severity = getParam(rawParams, 'event_nseverity', getParam(rawParams, 'trigger_nseverity', '')),
        mapped = hasValue(severity) && isObject(severityMap[String(severity)]) ? severityMap[String(severity)] : {},
        impact = getParamOrTag(itopParams, tags, 'impact', 'itop_impact'),
        urgency = getParamOrTag(itopParams, tags, 'urgency', 'itop_urgency'),
        priority = getParamOrTag(itopParams, tags, 'priority', 'itop_priority');

    setFieldIfValue(fields, 'impact', impact || mapped.impact);
    setFieldIfValue(fields, 'urgency', urgency || mapped.urgency);

    if (parseBoolean(itopParams.set_priority_directly, false)) {
        setFieldIfValue(fields, 'priority', priority || mapped.priority);
    }

    return fields;
}

function buildAssignmentFields(itopParams, tags) {
    var fields = {};

    setFieldIfValue(fields, 'team_id', getParamOrTag(itopParams, tags, 'team_id', 'itop_team_id'));
    setFieldIfValue(fields, 'agent_id', getParamOrTag(itopParams, tags, 'agent_id', 'itop_agent_id'));
    mergeFields(fields, parseJSONParam(itopParams, 'assign_fields_json', {}));

    return fields;
}

function chooseAssignmentStimulus(itopParams, assignmentFields, operationType) {
    if (hasValue(itopParams.assignment_stimulus)) {
        return itopParams.assignment_stimulus;
    }

    if (hasValue(assignmentFields.team_id) && !hasValue(assignmentFields.agent_id)
            && parseBoolean(itopParams.assign_team_only, false)) {
        return getParam(itopParams, 'dispatch_stimulus', 'ev_dispatch');
    }

    return operationType === 'update'
        ? getParam(itopParams, 'reassign_stimulus', 'ev_reassign')
        : getParam(itopParams, 'assign_stimulus', 'ev_assign');
}

function buildRecoveryFields(rawParams, itopParams) {
    var fields = {},
        logFormat = getParam(itopParams, 'log_format', 'text'),
        solution = getParam(itopParams, 'solution',
            'Recovered by Zabbix.\n\n' + rawParams.alert_subject + '\n' + rawParams.alert_message),
        resolutionCode = getParam(itopParams, 'resolution_code', 'other');

    setFieldIfValue(fields, 'solution', solution);
    setFieldIfValue(fields, 'resolution_code', resolutionCode);

    fields[itopParams.log] = buildCaseLog(rawParams.alert_subject + '\n' + rawParams.alert_message, logFormat);
    mergeFields(fields, parseJSONParam(itopParams, 'recovery_fields_json', {}));

    return fields;
}

var Itop = {
    params: {},

    setParams: function (params) {
        if (typeof params !== 'object') {
            return;
        }

        if (params.log !== 'private_log' && params.log !== 'public_log') {
            throw 'Incorrect "itop_log" parameter given: ' + params.log + '\nMust be "private_log" or "public_log".';
        }

        Itop.params = params;

        if (typeof Itop.params.url === 'string') {
            if (!Itop.params.url.endsWith('/')) {
                Itop.params.url += '/';
            }

            Itop.params.url += 'webservices/rest.php?version=' + encodeURIComponent(Itop.params.api_version);
        }
    },

    setProxy: function (HTTPProxy) {
        Itop.HTTPProxy = HTTPProxy;
    },

    validateParams: function (data) {
        var required = ['url', 'user', 'password', 'organization_id', 'class', 'api_version'];

        required.forEach(function (field) {
            if (!hasValue(Itop.params[field])) {
                throw 'Required Itop param is not set: "itop_' + field + '".';
            }
        });

        if (data.operation !== 'core/create' && !hasValue(data.key)) {
            throw 'Required iTop ticket key is not set for operation "' + data.operation + '".';
        }
    },

    buildBasePayload: function () {
        return {
            operation: '',
            class: Itop.params.class,
            comment: getParam(Itop.params, 'comment', 'Synchronized from Zabbix'),
            output_fields: getParam(Itop.params, 'output_fields', 'id, friendlyname, status'),
            fields: {}
        };
    },

    buildCreatePayload: function (rawParams, fields) {
        var payload = Itop.buildBasePayload();

        payload.operation = 'core/create';
        payload.fields.org_id = Itop.params.organization_id;
        payload.fields.title = rawParams.alert_subject;
        payload.fields.description = textToHtml(rawParams.alert_message);

        if (hasValue(rawParams.event_id)) {
            payload.fields.description += '<!-- zbx_eid:' + escapeHtml(rawParams.event_id) + ' -->';
        }

        setFieldIfValue(payload.fields, 'caller_id', Itop.params.caller_id);
        setFieldIfValue(payload.fields, 'origin', Itop.params.origin);
        setFieldIfValue(payload.fields, 'service_id', Itop.params.service_id);
        setFieldIfValue(payload.fields, 'servicesubcategory_id', Itop.params.servicesubcategory_id);
        setFieldIfValue(payload.fields, 'request_type', Itop.params.request_type);

        mergeFields(payload.fields, fields);
        mergeFields(payload.fields, parseJSONParam(Itop.params, 'create_fields_json', {}));

        return payload;
    },

    buildUpdatePayload: function (rawParams, fields) {
        var payload = Itop.buildBasePayload(),
            logFormat = getParam(Itop.params, 'log_format', 'text');

        payload.operation = 'core/update';
        payload.key = Itop.params.id;
        payload.fields[Itop.params.log] = buildCaseLog(rawParams.alert_subject + '\n' + rawParams.alert_message, logFormat);

        if (parseBoolean(Itop.params.update_title, true)) {
            payload.fields.title = rawParams.alert_subject;
        }

        mergeFields(payload.fields, fields);
        mergeFields(payload.fields, parseJSONParam(Itop.params, 'update_fields_json', {}));

        return payload;
    },

    buildStimulusPayload: function (id, stimulus, fields) {
        var payload = Itop.buildBasePayload();

        payload.operation = 'core/apply_stimulus';
        payload.key = id;
        payload.stimulus = stimulus;
        payload.fields = fields || {};

        return payload;
    },

    findExistingTicket: function (eventId) {
        if (!hasValue(eventId)) {
            return null;
        }

        var sanitizedId = String(eventId).replace(/[^0-9]/g, ''),
            dedupMarker,
            payload,
            queryResult;

        if (sanitizedId === '') {
            return null;
        }

        dedupMarker = 'zbx_eid:' + sanitizedId;
        payload = {
            operation: 'core/get',
            class: Itop.params.class,
            key: "SELECT " + Itop.params.class + " WHERE description LIKE '%" + dedupMarker + "%'",
            output_fields: getParam(Itop.params, 'output_fields', 'id, friendlyname, status')
        };

        try {
            queryResult = Itop.request(payload);

            if (queryResult && queryResult.response && hasValue(queryResult.response.id)) {
                Zabbix.log(4, '[ iTop Webhook ] Found existing ticket ' + queryResult.response.id +
                        ' for event ' + sanitizedId + ', skipping creation.');
                return queryResult.response;
            }
        }
        catch (e) {
            Zabbix.log(3, '[ iTop Webhook ] Deduplication check failed, proceeding with create: ' + e);
        }

        return null;
    },

    applyAssignment: function (id, assignmentFields, operationType) {
        var stimulus;

        if (!hasFields(assignmentFields)) {
            return;
        }

        stimulus = chooseAssignmentStimulus(Itop.params, assignmentFields, operationType);

        if (!hasValue(stimulus)) {
            return;
        }

        try {
            Itop.request(Itop.buildStimulusPayload(id, stimulus, assignmentFields));
        }
        catch (e) {
            Zabbix.log(3, '[ iTop Webhook ] Assignment failed (non-fatal): ' + e);
        }
    },

    applyRecovery: function (rawParams, id) {
        var stimuli = parseCSV(getParam(Itop.params, 'recovery_stimuli', 'ev_resolve,ev_close')),
            fields = buildRecoveryFields(rawParams, Itop.params),
            i;

        for (i = 0; i < stimuli.length; i++) {
            try {
                Itop.request(Itop.buildStimulusPayload(id, stimuli[i], i === 0 ? fields : {}));
            }
            catch (e) {
                Zabbix.log(3, '[ iTop Webhook ] Recovery stimulus "' + stimuli[i] + '" failed (non-fatal): ' + e);
            }
        }
    },

    request: function (data) {
        Itop.validateParams(data);

        var response,
            url = Itop.params.url,
            request = new HttpRequest(),
            object;

        request.addHeader('Content-Type: multipart/form-data');
        request.addHeader('Authorization: Basic ' + btoa(Itop.params.user + ':' + Itop.params.password));

        if (Itop.HTTPProxy) {
            request.setProxy(Itop.HTTPProxy);
        }

        data = JSON.stringify(data);

        Zabbix.log(4, '[ iTop Webhook ] Sending request: ' + url + '&json_data=' + data);

        response = request.post(url + '&json_data=' + encodeURIComponent(data));

        Zabbix.log(4, '[ iTop Webhook ] Received response with status code ' + request.getStatus() + '\n' + response);

        try {
            response = JSON.parse(response);
        }
        catch (error) {
            Zabbix.log(4, '[ iTop Webhook ] Failed to parse response received from iTop');
            throw 'Failed to parse response received from iTop.\nRequest status code ' +
                    request.getStatus() + '. Check debug log for more information.';
        }

        if (request.getStatus() < 200 || request.getStatus() >= 300) {
            throw 'Request failed with status code ' + request.getStatus() + '. Check debug log for more information.';
        }
        else if (typeof response.code !== 'undefined' && response.code !== 0) {
            throw 'Request failed with iTop code ' + response.code + ': ' +
                    JSON.stringify(response.message) + '. Check debug log for more information.';
        }
        else {
            if (isObject(response.objects)) {
                Object.keys(response.objects)
                    .forEach(function (key) {
                        object = response.objects[key];
                    });
            }

            return {
                status: request.getStatus(),
                response: object && object.fields ? object.fields : response
            };
        }
    }
};

try {
    var params = JSON.parse(value),
        itop_params = {},
        result = {tags: {}},
        required_params = [
            'alert_subject', 'summary', 'event_recovery_value',
            'event_source', 'event_value', 'action_name'
        ],
        eventTags,
        priorityFields,
        assignmentFields,
        isTriggerEvent,
        isProblemEvent,
        isUpdateEvent,
        isRecoveryEvent,
        existing,
        response;

    Object.keys(params)
        .forEach(function (key) {
            if (key.startsWith('itop_')) {
                itop_params[key.substring(5)] = params[key];
            }
            else if (required_params.indexOf(key) !== -1 && params[key] === '') {
                throw 'Parameter "' + key + '" can\'t be empty.';
            }
        });

    if ([0, 1, 2, 3, 4].indexOf(parseInt(params.event_source)) === -1) {
        throw 'Incorrect "event_source" parameter given: ' + params.event_source + '\nMust be 0-4.';
    }

    // Check {EVENT.VALUE} for trigger-based and internal events.
    if (params.event_value !== '0' && params.event_value !== '1'
            && (params.event_source === '0' || params.event_source === '3')) {
        throw 'Incorrect "event_value" parameter given: ' + params.event_value + '\nMust be 0 or 1.';
    }

    // Check {EVENT.UPDATE.STATUS} only for trigger-based events.
    if (params.event_update_status !== '0' && params.event_update_status !== '1' && params.event_source === '0') {
        throw 'Incorrect "event_update_status" parameter given: ' + params.event_update_status + '\nMust be 0 or 1.';
    }

    if (params.event_source !== '0' && params.event_recovery_value === '0') {
        throw 'Recovery operations are supported only for trigger-based actions.';
    }

    Itop.setParams(itop_params);
    Itop.setProxy(params.HTTPProxy);

    eventTags = parseEventTags(params);
    priorityFields = buildPriorityFields(params, Itop.params, eventTags);
    assignmentFields = buildAssignmentFields(Itop.params, eventTags);

    isTriggerEvent = params.event_source === '0';
    isProblemEvent = params.event_value === '1';
    isUpdateEvent = params.event_update_status === '1';
    isRecoveryEvent = isTriggerEvent && params.event_value === '0';

    // Create issue for non trigger-based events.
    if (!isTriggerEvent && params.event_recovery_value !== '0') {
        existing = Itop.findExistingTicket(params.event_id);

        if (existing) {
            response = {response: existing};
        }
        else {
            response = Itop.request(Itop.buildCreatePayload(params, priorityFields));

            if (parseBoolean(Itop.params.assign_on_create, true)) {
                Itop.applyAssignment(response.response.id, assignmentFields, 'create');
            }
        }
    }
    // Create issue for trigger-based events.
    else if (isProblemEvent && !isUpdateEvent && Itop.params.id === '{EVENT.TAGS.__zbx_itop_id}') {
        existing = Itop.findExistingTicket(params.event_id);

        if (existing) {
            response = {response: existing};
        }
        else {
            response = Itop.request(Itop.buildCreatePayload(params, priorityFields));

            if (parseBoolean(Itop.params.assign_on_create, true)) {
                Itop.applyAssignment(response.response.id, assignmentFields, 'create');
            }
        }

        result.tags.__zbx_itop_id = response.response.id;
        result.tags.__zbx_itop_key = response.response.friendlyname;
        result.tags.__zbx_itop_link = params.itop_url + (params.itop_url.endsWith('/') ? '' : '/') +
                'pages/UI.php?operation=details&class=' + encodeURIComponent(Itop.params.class) + '&id=' +
                encodeURIComponent(response.response.id);
    }
    // Update, assign or close an already created trigger-based issue.
    else {
        if (Itop.params.id === '{EVENT.TAGS.__zbx_itop_id}') {
            throw 'Incorrect iTop ticket ID given: ' + Itop.params.id;
        }

        Itop.request(Itop.buildUpdatePayload(params, isRecoveryEvent ? {} : priorityFields));

        if (!isRecoveryEvent && parseBoolean(Itop.params.assign_on_update, false)) {
            Itop.applyAssignment(Itop.params.id, assignmentFields, 'update');
        }

        if (isRecoveryEvent && parseBoolean(Itop.params.auto_close, false)) {
            Itop.applyRecovery(params, Itop.params.id);
        }
    }

    return JSON.stringify(result);
}
catch (error) {
    Zabbix.log(3, '[ iTop Webhook ] ERROR: ' + error);
    throw 'Sending failed: ' + error;
}
