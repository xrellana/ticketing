// Zabbix severity -> iTop impact / urgency mapping
var SEVERITY_MAP = {
    '5': {impact: '1', urgency: 'critical'},   // Disaster
    '4': {impact: '1', urgency: 'high'},        // High
    '3': {impact: '2', urgency: 'medium'},      // Average
    '2': {impact: '3', urgency: 'low'},          // Warning
    '1': {impact: '3', urgency: 'low'},          // Information
    '0': {impact: '3', urgency: 'low'}           // Not classified
};

function isUnresolvedMacro(value) {
    return typeof value === 'string'
        && /^\{[$#]?[A-Za-z0-9_.:"\\ -]+\}$/.test(value);
}

function hasValue(value) {
    return typeof value !== 'undefined'
        && value !== null
        && String(value) !== ''
        && !isUnresolvedMacro(value);
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

// ---------------------------------------------------------------------------
// iTop REST API client
// ---------------------------------------------------------------------------
var Itop = {
    params: {},

    setParams: function (params) {
        if (typeof params !== 'object') {
            return;
        }

        if (params.log !== 'private_log' && params.log !== 'public_log') {
            throw 'Incorrect "itop_log" parameter given: ' + params.log
                + '\nMust be "private_log" or "public_log".';
        }

        Itop.params = params;

        if (hasValue(Itop.params.url)) {
            if (!Itop.params.url.endsWith('/')) {
                Itop.params.url += '/';
            }

            Itop.params.url += 'webservices/rest.php?version='
                + encodeURIComponent(Itop.params.api_version);
        }
    },

    setProxy: function (HTTPProxy) {
        Itop.HTTPProxy = HTTPProxy;
    },

    // ---- Build payloads ---------------------------------------------------

    buildCreatePayload: function (rawParams) {
        var severity  = hasValue(rawParams.event_nseverity) ? rawParams.event_nseverity : '0',
            mapped    = SEVERITY_MAP[String(severity)] || SEVERITY_MAP['0'],
            p         = Itop.params,
            fields    = {};

        fields.org_id      = p.organization_id;
        fields.title       = rawParams.alert_subject;
        fields.description = textToHtml(rawParams.alert_message);
        fields.impact      = mapped.impact;
        fields.urgency     = mapped.urgency;

        if (hasValue(p.caller_id))              fields.caller_id              = p.caller_id;
        if (hasValue(p.origin))                 fields.origin                 = p.origin;
        if (hasValue(p.service_id))             fields.service_id             = p.service_id;
        if (hasValue(p.servicesubcategory_id))  fields.servicesubcategory_id  = p.servicesubcategory_id;
        if (hasValue(p.request_type))           fields.request_type           = p.request_type;

        return {
            operation:     'core/create',
            class:         p.class,
            comment:       hasValue(p.comment) ? p.comment : 'Synchronized from Zabbix',
            output_fields: hasValue(p.output_fields) ? p.output_fields : 'id, friendlyname, status',
            fields:        fields
        };
    },

    buildStimulusPayload: function (id, stimulus, fields) {
        return {
            operation:     'core/apply_stimulus',
            class:         Itop.params.class,
            key:           id,
            stimulus:      stimulus,
            comment:       hasValue(Itop.params.comment)
                ? Itop.params.comment
                : 'Synchronized from Zabbix',
            output_fields: hasValue(Itop.params.output_fields)
                ? Itop.params.output_fields
                : 'id, friendlyname, status',
            fields:        fields || {}
        };
    },

    // ---- Actions ----------------------------------------------------------

    createTicket: function (rawParams) {
        var payload  = Itop.buildCreatePayload(rawParams),
            response = Itop.request(payload);

        return response;
    },

    assignTicket: function (id) {
        var fields = {},
            p      = Itop.params;

        if (hasValue(p.team_id))  fields.team_id  = p.team_id;
        if (hasValue(p.agent_id)) fields.agent_id = p.agent_id;

        // Nothing to assign
        if (!fields.team_id && !fields.agent_id) {
            return;
        }

        try {
            Itop.request(Itop.buildStimulusPayload(id, 'ev_assign', fields));
        }
        catch (e) {
            Zabbix.log(3, '[ iTop Webhook ] Assignment failed (non-fatal): ' + e);
        }
    },

    closeTicket: function (rawParams, id) {
        var p        = Itop.params,
            solution = hasValue(p.solution)
                ? p.solution
                : ('Recovered by Zabbix.\n\n'
                    + rawParams.alert_subject + '\n' + rawParams.alert_message),
            resolveFields = {};

        resolveFields.solution        = solution;
        resolveFields.resolution_code = hasValue(p.resolution_code) ? p.resolution_code : 'other';
        resolveFields[p.log]          = {
            add_item: {
                message: rawParams.alert_subject + '\n' + rawParams.alert_message,
                format:  'text'
            }
        };

        // Step 1: resolve
        Itop.request(Itop.buildStimulusPayload(id, 'ev_resolve', resolveFields));
        // Step 2: close
        Itop.request(Itop.buildStimulusPayload(id, 'ev_close', {}));
    },

    // ---- HTTP request -----------------------------------------------------

    request: function (data) {
        var required = ['url', 'user', 'password', 'organization_id', 'class', 'api_version'],
            i, response, request, object;

        for (i = 0; i < required.length; i++) {
            if (!hasValue(Itop.params[required[i]])) {
                throw 'Required iTop param is not set: "itop_' + required[i] + '".';
            }
        }

        request = new HttpRequest();
        request.addHeader('Content-Type: multipart/form-data');
        request.addHeader('Authorization: Basic '
            + btoa(Itop.params.user + ':' + Itop.params.password));

        if (hasValue(Itop.HTTPProxy)) {
            request.setProxy(Itop.HTTPProxy);
        }

        var payload = JSON.stringify(data);

        Zabbix.log(4, '[ iTop Webhook ] Sending request: ' + Itop.params.url
            + '&json_data=' + payload);

        response = request.post(Itop.params.url + '&json_data=' + encodeURIComponent(payload));

        Zabbix.log(4, '[ iTop Webhook ] Received response with status code '
            + request.getStatus() + '\n' + response);

        try {
            response = JSON.parse(response);
        }
        catch (error) {
            throw 'Failed to parse iTop response. Status code ' + request.getStatus()
                + '. Check debug log for more information.';
        }

        if (request.getStatus() < 200 || request.getStatus() >= 300) {
            throw 'Request failed with status code ' + request.getStatus() + '.';
        }

        if (typeof response.code !== 'undefined' && response.code !== 0) {
            throw 'iTop error code ' + response.code + ': '
                + JSON.stringify(response.message);
        }

        // Extract the first (and usually only) object from the response
        object = null;

        if (response.objects && typeof response.objects === 'object') {
            Object.keys(response.objects).forEach(function (key) {
                object = response.objects[key];
            });
        }

        return {
            status:   request.getStatus(),
            response: object && object.fields ? object.fields : response
        };
    }
};

// ===========================================================================
// Main
// ===========================================================================
try {
    var params      = JSON.parse(value),
        itop_params = {},
        result      = {tags: {}},
        response;

    // Split itop_* params out
    Object.keys(params).forEach(function (key) {
        if (key.startsWith('itop_')) {
            itop_params[key.substring(5)] = params[key];
        }
    });

    // Basic validation
    if (!hasValue(params.alert_subject)) throw 'Parameter "alert_subject" is empty.';
    if (!hasValue(params.alert_message)) throw 'Parameter "alert_message" is empty.';

    if (params.event_source !== '0') {
        throw 'Only trigger-based events are supported (event_source=0). Got: '
            + params.event_source;
    }

    if (params.event_value !== '0' && params.event_value !== '1') {
        throw 'Incorrect "event_value" parameter: ' + params.event_value
            + '. Must be 0 or 1.';
    }

    Itop.setParams(itop_params);
    Itop.setProxy(params.HTTPProxy);

    var isProblemEvent  = params.event_value === '1';
    var isRecoveryEvent = params.event_value === '0';

    if (isProblemEvent) {
        // ---- CREATE TICKET ------------------------------------------------
        response = Itop.createTicket(params);

        // Write tags back to Zabbix event
        result.tags.__zbx_itop_id  = response.response.id;
        result.tags.__zbx_itop_key = response.response.friendlyname;
        result.tags.__zbx_itop_link = params.itop_url
            + (params.itop_url.endsWith('/') ? '' : '/')
            + 'pages/UI.php?operation=details&class='
            + encodeURIComponent(Itop.params.class)
            + '&id=' + encodeURIComponent(response.response.id);

        // Assign to team / agent
        Itop.assignTicket(response.response.id);
    }
    else if (isRecoveryEvent) {
        // ---- CLOSE TICKET -------------------------------------------------
        if (!hasValue(itop_params.id)) {
            throw 'Cannot close ticket: iTop ticket ID is not available. '
                + 'Make sure the create action ran successfully and "Process tags" is enabled.';
        }

        Itop.closeTicket(params, itop_params.id);
    }

    return JSON.stringify(result);
}
catch (error) {
    Zabbix.log(3, '[ iTop Webhook ] ERROR: ' + error);
    throw 'Sending failed: ' + error;
}
