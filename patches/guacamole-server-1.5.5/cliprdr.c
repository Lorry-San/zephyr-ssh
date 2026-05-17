/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#include "channels/cliprdr.h"
#include "client.h"
#include "common/clipboard.h"
#include "common/iconv.h"
#include "config.h"
#include "plugins/channels.h"
#include "rdp.h"

#include <freerdp/client/cliprdr.h>
#include <freerdp/event.h>
#include <freerdp/freerdp.h>
#include <guacamole/client.h>
#include <guacamole/mem.h>
#include <guacamole/stream.h>
#include <guacamole/user.h>
#include <winpr/clipboard.h>
#include <winpr/wtsapi.h>
#include <winpr/wtypes.h>

#include <assert.h>
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef FREERDP_CLIPRDR_CALLBACKS_REQUIRE_CONST
/**
 * FreeRDP 2.0.0-rc4 and newer requires the final argument for all CLIPRDR
 * callbacks to be const.
 */
#define CLIPRDR_CONST const
#else
/**
 * FreeRDP 2.0.0-rc3 and older requires the final argument to be mutable, but
 * current build environments expose const callback prototypes. Use const here;
 * this patch never mutates callback payloads.
 */
#define CLIPRDR_CONST const
#endif

#define GUAC_RDP_FILE_CLIPBOARD_MIMETYPE "application/vnd.zephyr.rdp.file-clipboard"
#define GUAC_RDP_FILEGROUPDESCRIPTORW_NAME "FileGroupDescriptorW"
#define GUAC_RDP_FILEDESCRIPTORW_SIZE 592
#define GUAC_RDP_FILEDESCRIPTORW_NAME_OFFSET 72
#define GUAC_RDP_FILEDESCRIPTORW_NAME_CHARS 260
#define GUAC_RDP_FD_ATTRIBUTES 0x00000004
#define GUAC_RDP_FD_FILESIZE 0x00000040
#define GUAC_RDP_FILE_ATTRIBUTE_NORMAL 0x00000080

static int guac_rdp_hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static void guac_rdp_percent_decode(char* value) {
    char* in = value;
    char* out = value;
    while (*in != '\0') {
        if (*in == '%' && guac_rdp_hex_value(in[1]) >= 0 && guac_rdp_hex_value(in[2]) >= 0) {
            *out++ = (char) ((guac_rdp_hex_value(in[1]) << 4) | guac_rdp_hex_value(in[2]));
            in += 3;
        }
        else
            *out++ = *in++;
    }
    *out = '\0';
}

static void guac_rdp_write_uint32_le(BYTE* buffer, UINT32 value) {
    buffer[0] = value & 0xFF;
    buffer[1] = (value >> 8) & 0xFF;
    buffer[2] = (value >> 16) & 0xFF;
    buffer[3] = (value >> 24) & 0xFF;
}

static void guac_rdp_clipboard_clear_files(guac_rdp_clipboard* clipboard) {
    if (clipboard == NULL)
        return;

    for (int i = 0; i < GUAC_RDP_FILE_CLIPBOARD_MAX_FILES; i++) {
        guac_mem_free(clipboard->files[i].name);
        guac_mem_free(clipboard->files[i].data);
        memset(&(clipboard->files[i]), 0, sizeof(guac_rdp_clipboard_file));
    }

    clipboard->file_count = 0;
    clipboard->file_generation++;
}

static char* guac_rdp_file_clipboard_sanitize_name(const char* name) {
    const char* fallback = "clipboard-file";
    if (name == NULL || *name == '\0')
        name = fallback;

    const char* base = name;
    for (const char* current = name; *current != '\0'; current++) {
        if (*current == '/' || *current == '\\')
            base = current + 1;
    }

    if (*base == '\0')
        base = fallback;

    size_t length = strnlen(base, 255);
    char* sanitized = guac_mem_alloc(length + 1);
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char) base[i];
        sanitized[i] = (c < 0x20 || strchr("<>:\"/\\|?*", c) != NULL) ? '_' : (char) c;
    }
    sanitized[length] = '\0';

    if (sanitized[0] == '\0')
        snprintf(sanitized, length + 1, "%s", fallback);

    return sanitized;
}

static int guac_rdp_file_clipboard_parse_header(const char* data, int length,
        char* name, size_t name_size, UINT64* file_size) {

    char header[1024];
    int copy_length = length < (int) sizeof(header) - 1 ? length : (int) sizeof(header) - 1;
    memcpy(header, data, copy_length);
    header[copy_length] = '\0';

    char* first_newline = strchr(header, '\n');
    if (first_newline != NULL)
        *first_newline = '\0';

    name[0] = '\0';
    *file_size = 0;

    char* saveptr = NULL;
    char* token = strtok_r(header, ";", &saveptr);
    while (token != NULL) {
        while (isspace((unsigned char) *token)) token++;
        char* equals = strchr(token, '=');
        if (equals != NULL) {
            *equals = '\0';
            char* key = token;
            char* value = equals + 1;
            if (strcmp(key, "name") == 0) {
                guac_rdp_percent_decode(value);
                snprintf(name, name_size, "%s", value);
            }
            else if (strcmp(key, "size") == 0)
                *file_size = strtoull(value, NULL, 10);
        }
        token = strtok_r(NULL, ";", &saveptr);
    }

    return name[0] != '\0';
}

static int guac_rdp_file_clipboard_add_file(guac_rdp_clipboard* clipboard,
        const char* name, UINT64 size) {

    if (clipboard->file_count >= GUAC_RDP_FILE_CLIPBOARD_MAX_FILES)
        return -1;

    int index = clipboard->file_count++;
    guac_rdp_clipboard_file* file = &(clipboard->files[index]);
    file->used = 1;
    file->name = guac_rdp_file_clipboard_sanitize_name(name);
    file->size = size;
    file->received = 0;
    file->data = size > 0 ? guac_mem_alloc(size) : NULL;

    return index;
}

static BYTE* guac_rdp_file_clipboard_build_descriptor(guac_rdp_clipboard* clipboard,
        UINT32* descriptor_size) {

    UINT32 file_count = clipboard->file_count;
    UINT32 size = 4 + file_count * GUAC_RDP_FILEDESCRIPTORW_SIZE;
    BYTE* descriptor = guac_mem_zalloc(size);
    guac_rdp_write_uint32_le(descriptor, file_count);

    for (UINT32 i = 0; i < file_count; i++) {
        guac_rdp_clipboard_file* file = &(clipboard->files[i]);
        BYTE* entry = descriptor + 4 + i * GUAC_RDP_FILEDESCRIPTORW_SIZE;

        guac_rdp_write_uint32_le(entry, GUAC_RDP_FD_ATTRIBUTES | GUAC_RDP_FD_FILESIZE);
        guac_rdp_write_uint32_le(entry + 32, GUAC_RDP_FILE_ATTRIBUTE_NORMAL);
        guac_rdp_write_uint32_le(entry + 64, (UINT32) ((file->size >> 32) & 0xFFFFFFFF));
        guac_rdp_write_uint32_le(entry + 68, (UINT32) (file->size & 0xFFFFFFFF));

        BYTE* name_out = entry + GUAC_RDP_FILEDESCRIPTORW_NAME_OFFSET;
        size_t name_length = strnlen(file->name, GUAC_RDP_FILEDESCRIPTORW_NAME_CHARS - 1);
        for (size_t j = 0; j < name_length; j++) {
            name_out[j * 2] = (BYTE) file->name[j];
            name_out[j * 2 + 1] = 0;
        }
    }

    *descriptor_size = size;
    return descriptor;
}

static UINT guac_rdp_cliprdr_send_file_contents_response(CliprdrClientContext* cliprdr,
        const CLIPRDR_FILE_CONTENTS_REQUEST* request) {

    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    CLIPRDR_FILE_CONTENTS_RESPONSE response = {
        .streamId = request->streamId,
        .msgFlags = CB_RESPONSE_OK
    };

    BYTE size_buffer[8];
    if (request->listIndex >= (UINT32) clipboard->file_count
            || !clipboard->files[request->listIndex].used) {
        response.msgFlags = CB_RESPONSE_FAIL;
        response.cbRequested = 0;
        response.requestedData = NULL;
    }
    else {
        guac_rdp_clipboard_file* file = &(clipboard->files[request->listIndex]);
        UINT64 offset = (((UINT64) request->nPositionHigh) << 32) | request->nPositionLow;

        if (request->dwFlags == FILECONTENTS_SIZE) {
            guac_rdp_write_uint32_le(size_buffer, (UINT32) (file->size & 0xFFFFFFFF));
            guac_rdp_write_uint32_le(size_buffer + 4, (UINT32) ((file->size >> 32) & 0xFFFFFFFF));
            response.cbRequested = sizeof(size_buffer);
            response.requestedData = size_buffer;
        }
        else if (request->dwFlags == FILECONTENTS_RANGE && offset <= file->size) {
            UINT64 available = file->size - offset;
            UINT32 requested = request->cbRequested;
            if (available < requested)
                requested = (UINT32) available;
            response.cbRequested = requested;
            response.requestedData = requested > 0 ? file->data + offset : NULL;
        }
        else {
            response.msgFlags = CB_RESPONSE_FAIL;
            response.cbRequested = 0;
            response.requestedData = NULL;
        }
    }

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Sending file contents response.");

    pthread_mutex_lock(&(rdp_client->message_lock));
    UINT result = cliprdr->ClientFileContentsResponse(cliprdr, &response);
    pthread_mutex_unlock(&(rdp_client->message_lock));

    return result;
}

/**
 * Sends a Format List PDU to the RDP server containing the formats of
 * clipboard data supported. This PDU is used both to indicate the general
 * clipboard formats supported at the begining of an RDP session and to inform
 * the RDP server that new clipboard data is available within the listed
 * formats.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the
 *     CLIPRDR channel for the current RDP session.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the Format List PDU was sent successfully, an
 *     error code (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_send_format_list(CliprdrClientContext* cliprdr) {

    /* This function is only invoked within FreeRDP-specific handlers for
     * CLIPRDR, which are not assigned, and thus not callable, until after the
     * relevant guac_rdp_clipboard structure is allocated and associated with
     * the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    int formats = 2;
    CLIPRDR_FORMAT available_formats[3] = {
        { .formatId = CF_TEXT },
        { .formatId = CF_UNICODETEXT },
        { .formatId = clipboard->file_group_descriptor_format, .formatName = GUAC_RDP_FILEGROUPDESCRIPTORW_NAME }
    };

    if (clipboard->file_count > 0 && clipboard->file_group_descriptor_format)
        formats = 3;

    /* We support CP-1252/UTF-16 text and, when available, Windows file clipboard. */
    CLIPRDR_FORMAT_LIST format_list = {
        .msgType = CB_FORMAT_LIST,
        .formats = available_formats,
        .numFormats = formats
    };

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Sending format list");

    pthread_mutex_lock(&(rdp_client->message_lock));
    int retval = cliprdr->ClientFormatList(cliprdr, &format_list);
    pthread_mutex_unlock(&(rdp_client->message_lock));
    return retval;

}

/**
 * Sends a Clipboard Capabilities PDU to the RDP server describing the features
 * of the CLIPRDR channel that are supported by the client.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the
 *     CLIPRDR channel for the current RDP session.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the Clipboard Capabilities PDU was sent
 *     successfully, an error code (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_send_capabilities(CliprdrClientContext* cliprdr) {

    /* This function is only invoked within FreeRDP-specific handlers for
     * CLIPRDR, which are not assigned, and thus not callable, until after the
     * relevant guac_rdp_clipboard structure is allocated and associated with
     * the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    /* We support CP-1252 and UTF-16 text */
    CLIPRDR_GENERAL_CAPABILITY_SET cap_set = {
        .capabilitySetType = CB_CAPSTYPE_GENERAL, /* CLIPRDR specification requires that this is CB_CAPSTYPE_GENERAL, the only defined set type */
        .capabilitySetLength = 12, /* The size of the capability set within the PDU - for CB_CAPSTYPE_GENERAL, this is ALWAYS 12 bytes */
        .version = CB_CAPS_VERSION_2, /* The version of the CLIPRDR specification supported */
        .generalFlags = CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED /* Bitwise OR of all supported feature flags */
    };

    CLIPRDR_CAPABILITIES caps = {
        .cCapabilitiesSets = 1,
        .capabilitySets = (CLIPRDR_CAPABILITY_SET*) &cap_set
    };

    pthread_mutex_lock(&(rdp_client->message_lock));
    int retval = cliprdr->ClientCapabilities(cliprdr, &caps);
    pthread_mutex_unlock(&(rdp_client->message_lock));

    return retval;

}

/**
 * Callback invoked by the FreeRDP CLIPRDR plugin for received Monitor Ready
 * PDUs. The Monitor Ready PDU is sent by the RDP server only during
 * initialization of the CLIPRDR channel. It is part of the CLIPRDR channel
 * handshake and indicates that the RDP server's handling of clipboard
 * redirection is ready to proceed.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the CLIPRDR
 *     channel for the current RDP session.
 *
 * @param monitor_ready
 *     The CLIPRDR_MONITOR_READY structure representing the Monitor Ready PDU
 *     that was received.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the PDU was handled successfully, an error code
 *     (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_monitor_ready(CliprdrClientContext* cliprdr,
        CLIPRDR_CONST CLIPRDR_MONITOR_READY* monitor_ready) {

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client_log(clipboard->client, GUAC_LOG_TRACE, "CLIPRDR: Received "
            "monitor ready.");

    /* Respond with capabilities ... */
    int status = guac_rdp_cliprdr_send_capabilities(cliprdr);
    if (status != CHANNEL_RC_OK)
        return status;

    /* ... and supported format list */
    return guac_rdp_cliprdr_send_format_list(cliprdr);

}

/**
 * Sends a Format Data Request PDU to the RDP server, requesting that available
 * clipboard data be sent to the client in the specified format. This PDU is
 * sent when the server indicates that clipboard data is available via a Format
 * List PDU.
 *
 * @param client
 *     The guac_client associated with the current RDP session.
 *
 * @param format
 *     The clipboard format to request. This format must be one of the
 *     documented values used by the CLIPRDR channel for clipboard format IDs.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the PDU was handled successfully, an error code
 *     (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_send_format_data_request(
        CliprdrClientContext* cliprdr, UINT32 format) {

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    /* Create new data request */
    CLIPRDR_FORMAT_DATA_REQUEST data_request = {
        .requestedFormatId = format
    };

    /* Note the format we've requested for reference later when the requested
     * data is received via a Format Data Response PDU */
    clipboard->requested_format = format;

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Sending format data request.");

    /* Send request */
    pthread_mutex_lock(&(rdp_client->message_lock));
    int retval = cliprdr->ClientFormatDataRequest(cliprdr, &data_request);
    pthread_mutex_unlock(&(rdp_client->message_lock));

    return retval;

}

/**
 * Returns whether the given Format List PDU indicates support for the given
 * clipboard format.
 *
 * @param format_list
 *     The CLIPRDR_FORMAT_LIST structure representing the Format List PDU
 *     being tested.
 *
 * @param format_id
 *     The ID of the clipboard format to test, such as CF_TEXT or
 *     CF_UNICODETEXT.
 *
 * @return
 *     Non-zero if the given Format List PDU indicates support for the given
 *     clipboard format, zero otherwise.
 */
static int guac_rdp_cliprdr_format_supported(const CLIPRDR_FORMAT_LIST* format_list,
        UINT format_id) {

    /* Search format list for matching ID */
    for (int i = 0; i < format_list->numFormats; i++) {
        if (format_list->formats[i].formatId == format_id)
            return 1;
    }

    /* If no matching ID, format is not supported */
    return 0;

}

/**
 * Callback invoked by the FreeRDP CLIPRDR plugin for received Format List
 * PDUs. The Format List PDU is sent by the RDP server to indicate that new
 * clipboard data has been copied and is available for retrieval in the formats
 * listed. A client wishing to retrieve that data responds with a Format Data
 * Request PDU.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the CLIPRDR
 *     channel for the current RDP session.
 *
 * @param format_list
 *     The CLIPRDR_FORMAT_LIST structure representing the Format List PDU that
 *     was received.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the PDU was handled successfully, an error code
 *     (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_format_list(CliprdrClientContext* cliprdr,
        CLIPRDR_CONST CLIPRDR_FORMAT_LIST* format_list) {

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Received format list.");

    CLIPRDR_FORMAT_LIST_RESPONSE format_list_response = {
        .msgFlags = CB_RESPONSE_OK
    };

    /* Report successful processing of format list */
    pthread_mutex_lock(&(rdp_client->message_lock));
    cliprdr->ClientFormatListResponse(cliprdr, &format_list_response);
    pthread_mutex_unlock(&(rdp_client->message_lock));

    /* Prefer Unicode (in this case, UTF-16) */
    if (guac_rdp_cliprdr_format_supported(format_list, CF_UNICODETEXT))
        return guac_rdp_cliprdr_send_format_data_request(cliprdr, CF_UNICODETEXT);

    /* Use Windows' CP-1252 if Unicode unavailable */
    if (guac_rdp_cliprdr_format_supported(format_list, CF_TEXT))
        return guac_rdp_cliprdr_send_format_data_request(cliprdr, CF_TEXT);

    /* Ignore any unsupported data */
    guac_client_log(client, GUAC_LOG_DEBUG, "Ignoring unsupported clipboard "
            "data. Only Unicode and text clipboard formats are currently "
            "supported.");

    return CHANNEL_RC_OK;

}

/**
 * Callback invoked by the FreeRDP CLIPRDR plugin for received Format Data
 * Request PDUs. The Format Data Request PDU is sent by the RDP server when
 * requesting that clipboard data be sent, in response to a received Format
 * List PDU. The client is required to respond with a Format Data Response PDU
 * containing the requested data.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the CLIPRDR
 *     channel for the current RDP session.
 *
 * @param format_data_request
 *     The CLIPRDR_FORMAT_DATA_REQUEST structure representing the Format Data
 *     Request PDU that was received.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the PDU was handled successfully, an error code
 *     (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_format_data_request(CliprdrClientContext* cliprdr,
        CLIPRDR_CONST CLIPRDR_FORMAT_DATA_REQUEST* format_data_request) {

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_settings* settings = rdp_client->settings;

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Received format data request.");

    guac_iconv_write* remote_writer;
    const char* input = clipboard->clipboard->buffer;
    char* output = guac_mem_alloc(GUAC_COMMON_CLIPBOARD_MAX_LENGTH);

    /* Map requested clipboard format to a guac_iconv writer */
    switch (format_data_request->requestedFormatId) {

        case CF_TEXT:
            remote_writer = settings->clipboard_crlf ? GUAC_WRITE_CP1252_CRLF : GUAC_WRITE_CP1252;
            break;

        case CF_UNICODETEXT:
            remote_writer = settings->clipboard_crlf ? GUAC_WRITE_UTF16_CRLF : GUAC_WRITE_UTF16;
            break;

        case 0:
            guac_mem_free(output);
            return CHANNEL_RC_OK;

        /* Windows shell requests FileGroupDescriptorW before requesting file ranges. */
        default:
            if (format_data_request->requestedFormatId == clipboard->file_group_descriptor_format
                    && clipboard->file_count > 0) {
                UINT32 descriptor_size = 0;
                BYTE* descriptor = guac_rdp_file_clipboard_build_descriptor(clipboard, &descriptor_size);
                CLIPRDR_FORMAT_DATA_RESPONSE data_response = {
                    .requestedFormatData = descriptor,
                    .dataLen = descriptor_size,
                    .msgFlags = CB_RESPONSE_OK
                };

                guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Sending FileGroupDescriptorW response.");
                pthread_mutex_lock(&(rdp_client->message_lock));
                UINT result = cliprdr->ClientFormatDataResponse(cliprdr, &data_response);
                pthread_mutex_unlock(&(rdp_client->message_lock));
                guac_mem_free(descriptor);
                guac_mem_free(output);
                return result;
            }

            guac_client_log(client, GUAC_LOG_WARNING, "Received clipboard "
                    "data cannot be sent to the RDP server because the RDP "
                    "server has requested a clipboard format which was not "
                    "declared as available. This violates the specification "
                    "for the CLIPRDR channel.");
            guac_mem_free(output);
            return CHANNEL_RC_OK;

    }

    /* Send received clipboard data to the RDP server in the format
     * requested */
    BYTE* start = (BYTE*) output;
    guac_iconv_read* local_reader = settings->normalize_clipboard ? GUAC_READ_UTF8_NORMALIZED : GUAC_READ_UTF8;
    guac_iconv(local_reader, &input, clipboard->clipboard->length,
            remote_writer, &output, GUAC_COMMON_CLIPBOARD_MAX_LENGTH);

    CLIPRDR_FORMAT_DATA_RESPONSE data_response = {
        .requestedFormatData = (BYTE*) start,
        .dataLen = ((BYTE*) output) - start,
        .msgFlags = CB_RESPONSE_OK
    };

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Sending format data response.");

    pthread_mutex_lock(&(rdp_client->message_lock));
    UINT result = cliprdr->ClientFormatDataResponse(cliprdr, &data_response);
    pthread_mutex_unlock(&(rdp_client->message_lock));

    guac_mem_free(start);
    return result;

}

static UINT guac_rdp_cliprdr_file_contents_request(CliprdrClientContext* cliprdr,
        CLIPRDR_CONST CLIPRDR_FILE_CONTENTS_REQUEST* file_contents_request) {

    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client_log(clipboard->client, GUAC_LOG_TRACE, "CLIPRDR: Received file contents request.");
    return guac_rdp_cliprdr_send_file_contents_response(cliprdr, file_contents_request);

}

/**
 * Callback invoked by the FreeRDP CLIPRDR plugin for received Format Data
 * Response PDUs. The Format Data Response PDU is sent by the RDP server when
 * fulfilling a request for clipboard data received via a Format Data Request
 * PDU.
 *
 * @param cliprdr
 *     The CliprdrClientContext structure used by FreeRDP to handle the CLIPRDR
 *     channel for the current RDP session.
 *
 * @param format_data_response
 *     The CLIPRDR_FORMAT_DATA_RESPONSE structure representing the Format Data
 *     Response PDU that was received.
 *
 * @return
 *     CHANNEL_RC_OK (zero) if the PDU was handled successfully, an error code
 *     (non-zero) otherwise.
 */
static UINT guac_rdp_cliprdr_format_data_response(CliprdrClientContext* cliprdr,
        CLIPRDR_CONST CLIPRDR_FORMAT_DATA_RESPONSE* format_data_response) {

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the CliprdrClientContext */
    guac_rdp_clipboard* clipboard = (guac_rdp_clipboard*) cliprdr->custom;
    assert(clipboard != NULL);

    guac_client* client = clipboard->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_settings* settings = rdp_client->settings;

    guac_client_log(client, GUAC_LOG_TRACE, "CLIPRDR: Received format data response.");

    /* Ignore received data if copy has been disabled */
    if (settings->disable_copy) {
        guac_client_log(client, GUAC_LOG_DEBUG, "Ignoring received clipboard "
                "data as copying from within the remote desktop has been "
                "explicitly disabled.");
        return CHANNEL_RC_OK;
    }

    char received_data[GUAC_COMMON_CLIPBOARD_MAX_LENGTH];

    guac_iconv_read* remote_reader;
    const char* input = (char*) format_data_response->requestedFormatData;
    char* output = received_data;

    /* Find correct source encoding */
    switch (clipboard->requested_format) {

        /* Non-Unicode (Windows CP-1252) */
        case CF_TEXT:
            remote_reader = settings->normalize_clipboard ? GUAC_READ_CP1252_NORMALIZED : GUAC_READ_CP1252;
            break;

        /* Unicode (UTF-16) */
        case CF_UNICODETEXT:
            remote_reader = settings->normalize_clipboard ? GUAC_READ_UTF16_NORMALIZED : GUAC_READ_UTF16;
            break;

        /* If the format ID stored within the guac_rdp_clipboard structure is actually
         * not supported here, then something has been implemented incorrectly.
         * Either incorrect values are (somehow) being stored, or support for
         * the format indicated by that value is incomplete and must be added
         * here. The values which may be stored within requested_format are
         * completely within our control. */
        default:
            guac_client_log(client, GUAC_LOG_DEBUG, "Requested clipboard data "
                    "in unsupported format (0x%X).", clipboard->requested_format);
            return CHANNEL_RC_OK;

    }

    /* Convert, store, and forward the clipboard data received from RDP
     * server */
    if (guac_iconv(remote_reader, &input, format_data_response->dataLen,
            GUAC_WRITE_UTF8, &output, sizeof(received_data))) {
        int length = strnlen(received_data, sizeof(received_data));
        guac_common_clipboard_reset(clipboard->clipboard, "text/plain");
        guac_common_clipboard_append(clipboard->clipboard, received_data, length);
        guac_common_clipboard_send(clipboard->clipboard, client);
    }

    return CHANNEL_RC_OK;

}

/**
 * Callback which associates handlers specific to Guacamole with the
 * CliprdrClientContext instance allocated by FreeRDP to deal with received
 * CLIPRDR (clipboard redirection) messages.
 *
 * This function is called whenever a channel connects via the PubSub event
 * system within FreeRDP, but only has any effect if the connected channel is
 * the CLIPRDR channel. This specific callback is registered with the PubSub
 * system of the relevant rdpContext when guac_rdp_clipboard_load_plugin() is
 * called.
 *
 * @param context
 *     The rdpContext associated with the active RDP session.
 *
 * @param e
 *     Event-specific arguments, mainly the name of the channel, and a
 *     reference to the associated plugin loaded for that channel by FreeRDP.
 */
static void guac_rdp_cliprdr_channel_connected(rdpContext* context,
        ChannelConnectedEventArgs* e) {

    guac_client* client = ((rdp_freerdp_context*) context)->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_clipboard* clipboard = rdp_client->clipboard;

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the guac_rdp_client */
    assert(clipboard != NULL);

    /* Ignore connection event if it's not for the CLIPRDR channel */
    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) != 0)
        return;

    /* The structure pointed to by pInterface is guaranteed to be a
     * CliprdrClientContext if the channel is CLIPRDR */
    CliprdrClientContext* cliprdr = (CliprdrClientContext*) e->pInterface;

    /* Associate FreeRDP CLIPRDR context and its Guacamole counterpart with
     * eachother */
    cliprdr->custom = clipboard;
    clipboard->cliprdr = cliprdr;

    cliprdr->MonitorReady = guac_rdp_cliprdr_monitor_ready;
    cliprdr->ServerFormatList = guac_rdp_cliprdr_format_list;
    cliprdr->ServerFormatDataRequest = guac_rdp_cliprdr_format_data_request;
    cliprdr->ServerFormatDataResponse = guac_rdp_cliprdr_format_data_response;
    cliprdr->ServerFileContentsRequest = guac_rdp_cliprdr_file_contents_request;

    guac_client_log(client, GUAC_LOG_DEBUG, "CLIPRDR (clipboard redirection) "
            "channel connected.");

}

/**
 * Callback which disassociates Guacamole from the CliprdrClientContext
 * instance that was originally allocated by FreeRDP and is about to be
 * deallocated.
 *
 * This function is called whenever a channel disconnects via the PubSub event
 * system within FreeRDP, but only has any effect if the disconnected channel
 * is the CLIPRDR channel. This specific callback is registered with the PubSub
 * system of the relevant rdpContext when guac_rdp_clipboard_load_plugin() is
 * called.
 *
 * @param context
 *     The rdpContext associated with the active RDP session.
 *
 * @param e
 *     Event-specific arguments, mainly the name of the channel, and a
 *     reference to the associated plugin loaded for that channel by FreeRDP.
 */
static void guac_rdp_cliprdr_channel_disconnected(rdpContext* context,
        ChannelDisconnectedEventArgs* e) {

    guac_client* client = ((rdp_freerdp_context*) context)->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_clipboard* clipboard = rdp_client->clipboard;

    /* FreeRDP-specific handlers for CLIPRDR are not assigned, and thus not
     * callable, until after the relevant guac_rdp_clipboard structure is
     * allocated and associated with the guac_rdp_client */
    assert(clipboard != NULL);

    /* Ignore disconnection event if it's not for the CLIPRDR channel */
    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) != 0)
        return;

    /* Channel is no longer connected */
    clipboard->cliprdr = NULL;

    guac_client_log(client, GUAC_LOG_DEBUG, "CLIPRDR (clipboard redirection) "
            "channel disconnected.");

}

guac_rdp_clipboard* guac_rdp_clipboard_alloc(guac_client* client) {

    /* Allocate clipboard and underlying storage */
    guac_rdp_clipboard* clipboard = guac_mem_zalloc(sizeof(guac_rdp_clipboard));
    clipboard->client = client;
    clipboard->clipboard = guac_common_clipboard_alloc();
    clipboard->requested_format = CF_TEXT;
    clipboard->file_group_descriptor_format = ClipboardRegisterFormat(NULL, GUAC_RDP_FILEGROUPDESCRIPTORW_NAME);

    return clipboard;

}

void guac_rdp_clipboard_load_plugin(guac_rdp_clipboard* clipboard,
        rdpContext* context) {

    /* Attempt to load FreeRDP support for the CLIPRDR channel */
    if (guac_freerdp_channels_load_plugin(context, "cliprdr", NULL)) {
        guac_client_log(clipboard->client, GUAC_LOG_WARNING,
                "Support for the CLIPRDR channel (clipboard redirection) "
                "could not be loaded. This support normally takes the form of "
                "a plugin which is built into FreeRDP. Lacking this support, "
                "clipboard will not work.");
        return;
    }

    /* Complete RDP side of initialization when channel is connected */
    PubSub_SubscribeChannelConnected(context->pubSub,
            (pChannelConnectedEventHandler) guac_rdp_cliprdr_channel_connected);

    /* Clean up any RDP-specific resources when channel is disconnected */
    PubSub_SubscribeChannelDisconnected(context->pubSub,
            (pChannelDisconnectedEventHandler) guac_rdp_cliprdr_channel_disconnected);

    guac_client_log(clipboard->client, GUAC_LOG_DEBUG, "Support for CLIPRDR "
            "(clipboard redirection) registered. Awaiting channel "
            "connection.");

}

void guac_rdp_clipboard_free(guac_rdp_clipboard* clipboard) {

    /* Do nothing if the clipboard is not actually allocated */
    if (clipboard == NULL)
        return;

    /* Free clipboard files and underlying storage */
    guac_rdp_clipboard_clear_files(clipboard);
    guac_common_clipboard_free(clipboard->clipboard);
    guac_mem_free(clipboard);

}

int guac_rdp_clipboard_handler(guac_user* user, guac_stream* stream,
        char* mimetype) {

    guac_client* client = user->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    /* Ignore stream creation if no clipboard structure is available to handle
     * received data */
    guac_rdp_clipboard* clipboard = rdp_client->clipboard;
    if (clipboard == NULL)
        return 0;

    if (strncmp(mimetype, GUAC_RDP_FILE_CLIPBOARD_MIMETYPE,
            sizeof(GUAC_RDP_FILE_CLIPBOARD_MIMETYPE) - 1) == 0) {

        char name[512];
        UINT64 file_size;
        if (!guac_rdp_file_clipboard_parse_header(mimetype, strlen(mimetype),
                name, sizeof(name), &file_size)) {
            guac_user_log(user, GUAC_LOG_WARNING, "Ignoring RDP file clipboard stream without file metadata.");
            return 0;
        }

        if (strstr(mimetype, ";reset=1") != NULL)
            guac_rdp_clipboard_clear_files(clipboard);

        int index = guac_rdp_file_clipboard_add_file(clipboard, name, file_size);
        if (index < 0) {
            guac_user_log(user, GUAC_LOG_WARNING, "Ignoring RDP file clipboard stream because the file limit was reached.");
            return 0;
        }

        guac_rdp_file_clipboard_stream* file_stream = guac_mem_zalloc(sizeof(guac_rdp_file_clipboard_stream));
        file_stream->clipboard = clipboard;
        file_stream->index = index;
        stream->data = file_stream;
        stream->blob_handler = guac_rdp_clipboard_blob_handler;
        stream->end_handler = guac_rdp_clipboard_end_handler;
        return 0;
    }

    /* Handle any future "blob" and "end" instructions for this stream with
     * handlers that are aware of the RDP clipboard state */
    stream->blob_handler = guac_rdp_clipboard_blob_handler;
    stream->end_handler = guac_rdp_clipboard_end_handler;

    /* Clear any current contents, assigning the mimetype the data which will
     * be received */
    guac_common_clipboard_reset(clipboard->clipboard, mimetype);
    return 0;

}

int guac_rdp_clipboard_blob_handler(guac_user* user, guac_stream* stream,
        void* data, int length) {

    guac_client* client = user->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    /* Ignore received data if no clipboard structure is available to handle
     * that data */
    guac_rdp_clipboard* clipboard = rdp_client->clipboard;
    if (clipboard == NULL)
        return 0;

    if (stream->data != NULL) {
        guac_rdp_file_clipboard_stream* file_stream = (guac_rdp_file_clipboard_stream*) stream->data;
        if (file_stream->index >= 0 && file_stream->index < clipboard->file_count) {
            guac_rdp_clipboard_file* file = &(clipboard->files[file_stream->index]);
            UINT64 remaining = file->size > file->received ? file->size - file->received : 0;
            UINT64 copy_length = length;
            if (copy_length > remaining)
                copy_length = remaining;
            if (copy_length > 0)
                memcpy(file->data + file->received, data, copy_length);
            file->received += copy_length;
        }
        return 0;
    }

    /* Append received data to current clipboard contents */
    guac_common_clipboard_append(clipboard->clipboard, (char*) data, length);
    return 0;

}

int guac_rdp_clipboard_end_handler(guac_user* user, guac_stream* stream) {

    guac_client* client = user->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;

    /* Ignore end of stream if no clipboard structure is available to handle
     * the data that was received */
    guac_rdp_clipboard* clipboard = rdp_client->clipboard;
    if (clipboard == NULL)
        return 0;

    if (stream->data != NULL) {
        guac_rdp_file_clipboard_stream* file_stream = (guac_rdp_file_clipboard_stream*) stream->data;
        int index = file_stream->index;
        guac_mem_free(file_stream);
        stream->data = NULL;

        if (index >= 0 && index < clipboard->file_count) {
            guac_rdp_clipboard_file* file = &(clipboard->files[index]);
            if (file->received != file->size)
                guac_user_log(user, GUAC_LOG_WARNING, "RDP file clipboard received incomplete file '%s' (%llu/%llu bytes).",
                        file->name, (unsigned long long) file->received, (unsigned long long) file->size);
            else
                guac_user_log(user, GUAC_LOG_DEBUG, "RDP file clipboard received file '%s' (%llu bytes).",
                        file->name, (unsigned long long) file->size);
        }

        if (clipboard->cliprdr != NULL) {
            guac_client_log(client, GUAC_LOG_DEBUG, "RDP file clipboard data received. Reporting file clipboard availability to RDP server.");
            guac_rdp_cliprdr_send_format_list(clipboard->cliprdr);
        }
        return 0;
    }

    /* Terminate clipboard data with NULL */
    guac_common_clipboard_append(clipboard->clipboard, "", 1);

    /* Notify RDP server of new data, if connected */
    if (clipboard->cliprdr != NULL) {
        guac_client_log(client, GUAC_LOG_DEBUG, "Clipboard data received. "
                "Reporting availability of clipboard data to RDP server.");
        guac_rdp_cliprdr_send_format_list(clipboard->cliprdr);
    }
    else
        guac_client_log(client, GUAC_LOG_DEBUG, "Clipboard data has been "
                "received, but cannot be sent to the RDP server because the "
                "CLIPRDR channel is not yet connected.");

    return 0;

}
