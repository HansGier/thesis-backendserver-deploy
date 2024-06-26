const fs = require('fs');
const path = require('path');
const { StatusCodes } = require("http-status-codes");
const {
    sequelize,
    projects: Project,
    media: Media,
    updates: Update,
} = require('../models');
const {
    ThrowErrorIf,
    BadRequestError,
    NotFoundError,
    ConflictError,
} = require("../errors");
const {
    getUpdateQuery,
    validationInput,
} = require("../utils/helpers");
const {
    createMediaRecord,
    handleError,
} = require('../utils/helpers/updatesHelpers');
const { checkPermissions } = require("../utils");
const { cloudinary } = require("../config/cloudinaryConfig");
const { Op } = require("sequelize");

/**
 * Creates an update for a project.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves when the update is created.
 */
const createUpdate = async (req, res) => {
    const { projectId } = req.params;
    const { remarks, progress, uploadedImages } = req.body;

    const t = await sequelize.transaction();

    try {
        validationInput({ projectId, remarks, progress }, 'create');

        // Find the project by its ID
        const project = await Project.findByPk(projectId, { transaction: t });
        ThrowErrorIf(!project, 'Project not found', NotFoundError);

        checkPermissions(req.user, project.createdBy);

        if (Number(progress) === 100) {
            project.status = "completed";
            project.progress = 100;
            await project.save({ transaction: t });
        } else {
            project.progress = Number(progress);
            project.status = "ongoing";
            await project.save({ transaction: t });
        }

        // Create the update record
        const update = await project.createUpdate({
            remarks,
            progress: Number(progress),
        }, {
            include: [
                {
                    model: Media,
                    as: 'media',
                    attributes: ['url', 'mime_type'],
                },
            ],
            transaction: t,
        });

        if (uploadedImages.length > 0) {
            // Create media records
            const mediaRecords = await Promise.all(
                uploadedImages.map((image) =>
                    Media.create(
                        {
                            url: image.secure_url,
                            mime_type: image.resource_type,
                            size: image.bytes,
                            update_id: update.id,
                            project_id: projectId,
                        },
                        { transaction: t },
                    ),
                ),
            );

            // Add the media records to the update
            await update.addMedia(mediaRecords, { transaction: t });
        }

        // Commit the transaction
        await t.commit();

        // Send the response
        res.status(StatusCodes.CREATED).json({
            msg: 'Update created',
            project_id: projectId,
            update,
        });
    } catch (error) {
        // Rollback the transaction
        await t.rollback();
        await handleError(error, projectId);
    }
};

/**
 * Retrieves all update for a specific project.
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise} - A promise that resolves to the response object.
 */
const getAllUpdate = async (req, res) => {
    // Extract the projectId from the request parameters
    const { projectId } = req.params;

    // Generate the options object for retrieving update
    const options = getUpdateQuery(req.query);

    // Throw an error if projectId is missing or invalid
    ThrowErrorIf(!projectId || projectId === ':projectId' || projectId === '', 'Project id is required', BadRequestError);

    // Find the project by its id
    const project = await Project.findByPk(projectId);

    // Throw an error if project is not found
    ThrowErrorIf(!project, 'Project not found', NotFoundError);

    // Count the total number of updates
    const count = await Update.count();

    // Retrieve the updates for the project
    const updates = await project.getUpdates(options);

    // Return a response with the updates
    if (updates.length < 1) {
        return res.status(StatusCodes.OK).json({ msg: 'No update' });
    } else {
        return res.status(StatusCodes.OK).json({
            totalCount: count,
            count: updates.length,
            updates,
        });
    }
};

/**
 * Retrieves the update for a specific project.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {void}
 */
const getUpdate = async (req, res) => {
    // Extract the project ID and update ID from the request parameters
    const { projectId, id } = req.params;

    // Find the project by its ID
    const project = await Project.findByPk(projectId);
    ThrowErrorIf(!project, 'Project not found', NotFoundError);

    // Find the update by its ID, including related media information
    const update = await Update.findOne({
        where: {
            id,
            project_id: projectId,
        },
        include: [
            {
                model: Media,
                as: 'media',
                attributes: ['id', 'url'],
            },
        ],
    });
    ThrowErrorIf(!update, 'Update not found', NotFoundError);

    // Send the update as the response
    res.status(StatusCodes.OK).json({ update });
};

/**
 * Edit the update of a project.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves when the update is updated.
 */
const editUpdate = async (req, res) => {
    // Destructure the request parameters and body
    const { projectId, id } = req.params;
    const { remarks, progress, uploadedImages } = req.body;

    const t = await sequelize.transaction();

    try {
        // Find the project by its ID
        const project = await Project.findByPk(projectId, { transaction: t });
        ThrowErrorIf(!project, 'Project not found', NotFoundError);

        checkPermissions(req.user, project.createdBy);

        // Find the update by its ID, including related media information
        const update = await Update.findByPk(id, {
            include: [
                {
                    model: Media,
                    as: 'media',
                    attributes: ['id', 'url'],
                },
            ],
            transaction: t,
        });
        ThrowErrorIf(!update, 'Update not found', NotFoundError);

        // Update the update record with the new data
        const updateData = {
            remarks: remarks || update.remarks,
            progress: progress || update.progress,
        };

        await update.update(updateData, { transaction: t });

        if (uploadedImages) {
            // Create new media records
            const newMediaRecords = await Promise.all(
                uploadedImages.map((image) =>
                    Media.create(
                        {
                            url: image.secure_url,
                            mime_type: image.resource_type,
                            size: image.bytes,
                            update_id: update.id,
                            project_id: projectId,
                        },
                        { transaction: t },
                    ),
                ),
            );

            // Add the new media records to the update
            await update.addMedia(newMediaRecords, { transaction: t });
        }

        // Reload the update with the updated data and associated media
        await update.reload({
            transaction: t,
        });

        await t.commit();

        res.status(StatusCodes.OK).json({ msg: 'Update edited', update });
    } catch (error) {
        await t.rollback();
        console.error(error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ msg: 'Failed to edit update', error: error.message });
    }
};


/**
 * Delete the update and associated media files for a project
 *
 * @param {object} req - The request object
 * @param {object} res - The response object
 */
const deleteUpdate = async (req, res) => {
    // Get the project ID and update ID from the request parameters
    const { projectId, id } = req.params;

    // Find the project by its ID
    const project = await Project.findByPk(projectId);
    ThrowErrorIf(!project, "Project not found", NotFoundError);

    checkPermissions(req.user, project.createdBy);

    // Find the update by its ID
    const update = await Update.findByPk(id);
    ThrowErrorIf(!update, "Update not found", NotFoundError);

    // Get the associated media records for the update
    const mediaRecords = await update.getMedia();
    if (mediaRecords) {
        // Delete the media files associated with the update from Cloudinary
        await Promise.all(
            mediaRecords.map(async (media) => {
                const publicId = media.url.split('/').pop().split('.')[0];
                await cloudinary.uploader.destroy(publicId);
            }),
        );
    }

    // Delete the update
    await update.destroy();

    // Return a success response
    res
        .status(StatusCodes.OK)
        .json({ msg: "Update and media files deleted" });
};

/**
 * Delete all updates and associated media files for a given project.
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Object} The response object with a success message.
 */
const deleteAllUpdate = async (req, res) => {
    // Get the projectId from the request parameters
    const { projectId } = req.params;
    // Validate the input
    validationInput({ projectId }, 'deleteAll');

    // Find the project by its id
    const project = await Project.findByPk(projectId);
    // Throw an error if the project is not
    ThrowErrorIf(!project, "Project not found", NotFoundError);

    checkPermissions(req.user, project.createdBy);

    // Get all updates
    const updates = await project.getUpdates();

    // If there are no updates, return a success message
    if (updates.length < 1)
        return res.status(StatusCodes.OK).json({ msg: "No update" });

    // Delete all associated media files for each update from Cloudinary
    await Promise.all(
        updates.map(async (update) => {
            const mediaRecords = await update.getMedia();
            await Promise.all(
                mediaRecords.map(async (media) => {
                    const publicId = media.url.split('/').pop().split('.')[0];
                    await cloudinary.uploader.destroy(publicId);
                }),
            );
        }),
    );

    // Delete all updates for the project
    await Update.destroy({ where: { project_id: project.id } });

    // Return a success message
    return res
        .status(StatusCodes.OK)
        .json({ msg: "All updates and media files deleted" });
};


module.exports = {
    createUpdate,
    getAllUpdate,
    getUpdate,
    editUpdate,
    deleteUpdate,
    deleteAllUpdate,
};

