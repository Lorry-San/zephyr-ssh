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

#ifndef GUAC_RDP_CHANNELS_CLIPRDR_H
#define GUAC_RDP_CHANNELS_CLIPRDR_H

#include "common/clipboard.h"

#include <freerdp/client/cliprdr.h>
#include <freerdp/freerdp.h>
#include <guacamole/client.h>
#include <guacamole/user.h>
#include <stdio.h>
#include <winpr/stream.h>
#include <winpr/wtypes.h>

#define GUAC_RDP_FILE_CLIPBOARD_MAX_FILES 64

/**
 * A single file currently exposed through the RDP CLIPRDR file clipboard.
 */
typedef struct guac_rdp_clipboard_file {

    /**
     * Whether this slot is used.
     */
    int used;

    /**
     * File name, without any path separators.
     */
    char* name;

    /**
     * File size in bytes.
     */
    UINT64 size;

    /**
     * Bytes received from the Guacamole web client.
     */
    UINT64 received;

    /**
     * Temporary file path containing clipboard file data.
     */
    char* path;

    /**
     * Temporary file handle used while receiving the browser upload.
     */
    FILE* upload_file;

    /**
     * Reusable range buffer used when answering CLIPRDR FileContents range requests.
     */
    BYTE* range_buffer;

    /**
     * Size of the reusable range buffer.
     */
    UINT32 range_buffer_size;

} guac_rdp_clipboard_file;

/**
 * Upload state for one inbound Guacamole clipboard/file stream.
 */
typedef struct guac_rdp_file_clipboard_stream {

    /**
     * The RDP clipboard associated with this upload.
     */
    struct guac_rdp_clipboard* clipboard;

    /**
     * Target file slot.
     */
    int index;

} guac_rdp_file_clipboard_stream;

/**
 * RDP clipboard, leveraging the "CLIPRDR" channel.
 */
typedef struct guac_rdp_clipboard {

    /**
     * The guac_client associated with the RDP connection. The broadcast
     * socket of this client will receive any clipboard data received from the
     * RDP server.
     */
    guac_client* client;

    /**
     * CLIPRDR control interface.
     */
    CliprdrClientContext* cliprdr;

    /**
     * The current clipboard contents.
     */
    guac_common_clipboard* clipboard;

    /**
     * The format of the clipboard which was requested. Data received from
     * the RDP server should conform to this format. This will be one of
     * several legal clipboard format values defined within FreeRDP's WinPR
     * library, such as CF_TEXT.
     */
    UINT requested_format;

    /**
     * Registered format ID for Windows FileGroupDescriptorW clipboard data.
     */
    UINT32 file_group_descriptor_format;

    /**
     * Files currently exposed through the RDP file clipboard.
     */
    guac_rdp_clipboard_file files[GUAC_RDP_FILE_CLIPBOARD_MAX_FILES];

    /**
     * Number of files currently exposed through the RDP file clipboard.
     */
    int file_count;

    /**
     * Upload generation ID. Incremented each time a new file clipboard starts.
     */
    UINT64 file_generation;

} guac_rdp_clipboard;

/**
 * Allocates a new guac_rdp_clipboard which has been initialized for processing
 * of Guacamole clipboard data. Support for the RDP side of the clipboard (the
 * CLIPRDR channel) must be loaded separately during FreeRDP's PreConnect event
 * using guac_rdp_clipboard_load_plugin().
 *
 * @param client
 *     The guac_client associated with the Guacamole side of the RDP
 *     connection.
 *
 * @return
 *     A newly-allocated instance of guac_rdp_clipboard which has been
 *     initialized for processing Guacamole clipboard data.
 */
guac_rdp_clipboard* guac_rdp_clipboard_alloc(guac_client* client);

/**
 * Initializes clipboard support for RDP and handling of the CLIPRDR channel.
 * If failures occur, messages noting the specifics of those failures will be
 * logged, and the RDP side of clipboard support will not be functional.
 *
 * This MUST be called within the PreConnect callback of the freerdp instance
 * for CLIPRDR support to be loaded.
 *
 * @param clipboard
 *     The guac_rdp_clipboard instance which has been allocated for the current
 *     RDP connection.
 *
 * @param context
 *     The rdpContext associated with the FreeRDP side of the RDP connection.
 */
void guac_rdp_clipboard_load_plugin(guac_rdp_clipboard* clipboard,
        rdpContext* context);

/**
 * Frees the resources associated with clipboard support for RDP and handling
 * of the CLIPRDR channel. Only resources specific to Guacamole are freed.
 * Resources specific to FreeRDP's handling of the CLIPRDR channel will be
 * freed by FreeRDP. If the provided guac_rdp_clipboard is NULL, this function
 * has no effect.
 *
 * @param clipboard
 *     The guac_rdp_clipboard instance which was been allocated for the current
 *     RDP connection.
 */
void guac_rdp_clipboard_free(guac_rdp_clipboard* clipboard);

/**
 * Handler for inbound clipboard data, received via the stream created by an
 * inbound "clipboard" instruction. This handler will assign the
 * stream-specific handlers for processing "blob" and "end" instructions which
 * will eventually be received as clipboard data is sent. This specific handler
 * is expected to be assigned to the guac_user object of any user that may send
 * clipboard data. The guac_rdp_clipboard instance which will receive this data
 * MUST already be stored on the guac_rdp_client structure associated with the
 * current RDP connection.
 */
guac_user_clipboard_handler guac_rdp_clipboard_handler;

/**
 * Handler for stream data related to clipboard, received via "blob"
 * instructions for a stream which has already been created with an inbound
 * "clipboard" instruction. This specific handler is assigned to the
 * guac_stream structure associated with that clipboard stream by
 * guac_rdp_clipboard_handler(). The guac_rdp_clipboard instance which will
 * receive this data MUST already be stored on the guac_rdp_client structure
 * associated with the current RDP connection.
 */
guac_user_blob_handler guac_rdp_clipboard_blob_handler;

/**
 * Handler for end-of-stream related to clipboard, indicated via an "end"
 * instruction for a stream which has already been created with an inbound
 * "clipboard" instruction. This specific handler is assigned to the
 * guac_stream structure associated with that clipboard stream by
 * guac_rdp_clipboard_handler(). The guac_rdp_clipboard instance which will
 * receive this data MUST already be stored on the guac_rdp_client structure
 * associated with the current RDP connection.
 */
guac_user_end_handler guac_rdp_clipboard_end_handler;

#endif
