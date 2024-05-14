const { StatusCodes } = require("http-status-codes");
const {
    sequelize,
    projects: Project,
    updates: Update,
    media: Media,
} = require('../models');
const { ThrowErrorIf, NotFoundError, BadRequestError } = require("../errors");
const { getMediaQuery } = require("../utils/helpers");
const { deleteMediaFiles, createMediaRecords, deleteUploadedFiles } = require("../utils/helpers/mediaHelpers");
const { checkPermissions } = require("../utils");
const cloudinary = require("cloudinary").v2;

const uploadMedia = async (req, res) => {
    await cloudinary.uploader.upload(req.file.path, function (err, result) {
        if (err) {
            console.log(err);
            return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
                success: false,
                msg: "Error uploading the image",
            });
        } else {
            return res.status(StatusCodes.OK).json({
                success: true,
                msg: "Image uploaded successfully",
                image_url: result,
            });
        }
    });
};

const deleteUploadedMedia = async (req, res) => {
    try {
        const { uploadedImages } = req.body;

        // Delete each uploaded image from Cloudinary
        await Promise.all(
            uploadedImages.map((image) =>
                cloudinary.uploader.destroy(image.url.split('/').pop().split('.')[0]),
            ),
        );

        res.status(200).json({ message: 'Uploaded images deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error deleting uploaded images' });
    }
};

/**
 * Retrieves all media based on the provided parameters.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 */
const getAllMedia = async (req, res) => {
    // Extract the required parameters from the request
    const { projectId, updateId } = req.params;
    const options = getMediaQuery(req.query);

    let result = {};

    const getMediaResult = async (model, id, options) => {
        // Find the entity by its ID
        const entity = await model.findByPk(id);
        ThrowErrorIf(!entity, `${ model.name } not found`, NotFoundError);

        // Retrieve the media associated with the entity
        const media = await entity.getMedia(options);

        // Count the total number of media associated with the entity
        const count = await entity.countMedia();

        return {
            [`${ model.name.toLowerCase() }_id`]: entity.id,
            totalCount: count,
            count: media.length,
            media,
        };
    };

    // Determine which model and ID to use based on the provided parameters
    if (updateId && projectId)
        result = await getMediaResult(Update, updateId, options);
    else if (projectId)
        result = await getMediaResult(Project, projectId, options);
    else
        throw new BadRequestError('Id is required');

    // Send the result as a JSON response
    res.status(StatusCodes.OK).json({ result });
};

/**
 * Updates the media for a project or update.
 *
 * @param {Object} req - The request object containing parameters and files.
 * @param {Object} res - The response object used to send the response.
 * @returns {Promise<void>} - A promise that resolves when the media is updated.
 */
const updateMedia = async (req, res) => {
    const { projectId, updateId } = req.params;
    const files = req.file;

    try {
        let result;

        // Check if files were uploaded
        if (!files) {
            return res.status(StatusCodes.OK).json({ msg: "You have not uploaded any files" });
        }

        if (updateId && projectId) {
            result = await sequelize.transaction(async (t) => {
                // Find the update
                const update = await Update.findOne({
                    where: { project_id: projectId, id: updateId },
                    transaction: t,
                });

                // Throw an error if update is not found
                ThrowErrorIf(!update, "Update not found", NotFoundError);

                // Delete existing media files
                const updateMedia = await update.getMedia({ transaction: t });
                await deleteMediaFiles(updateMedia, t);

                // Create new media records and associate them with the update
                const newMediaRecords = await createMediaRecords(files, projectId, updateId, t);
                await update.setMedia(newMediaRecords, { transaction: t });

                return update;
            });
        } else if (projectId) {
            result = await sequelize.transaction(async (t) => {
                // Find the project
                const project = await Project.findByPk(projectId, {
                    transaction: t,
                    attributes: ["id"],
                    include: [
                        {
                            model: Media,
                            as: "media",
                            attributes: ["url", "mime_type", "size", "createdAt", "updatedAt"],
                        },
                    ],
                });

                // Throw an error if project is not found
                ThrowErrorIf(!project, "Project not found", NotFoundError);

                // Delete existing media files
                const projectMedia = await project.getMedia({ transaction: t });
                await deleteMediaFiles(projectMedia, t);

                // Create new media records and associate them with the project
                const newMediaRecords = await createMediaRecords(files, projectId, null, t);
                await project.setMedia(newMediaRecords, { transaction: t });

                return project;
            });
        } else {
            new BadRequestError('Id is required');
        }

        // Reload the result to include the updated media
        await result.reload();

        // Send the response
        res.status(StatusCodes.OK).json({
            [`${ projectId && updateId ? "update" : "project" }`]: {
                id: result.id,
                media: result.media,
            },
        });
    } catch (e) {
        // Delete any uploaded files in case of an error
        await deleteUploadedFiles(files);
        throw e;
    }
};

/**
 * Deletes all media associated with a project or update.
 *
 * @param {Object} req - The request object containing parameters.
 * @param {Object} res - The response object to send back to the client.
 * @returns {Object} - The response object with a success message.
 */
const deleteAllMedia = async (req, res) => {
    const { projectId, updateId } = req.params;

    // If both projectId and updateId are provided
    if (projectId && updateId) {
        await sequelize.transaction(async (t) => {
            // Find the project by its ID
            const project = await Project.findByPk(projectId, { transaction: t });
            ThrowErrorIf(!project, "Project not found", NotFoundError);

            // Find the update by project ID and update ID
            const update = await Update.findOne({
                where: { project_id: projectId, id: updateId },
            }, { transaction: t });
            ThrowErrorIf(!update, "Update not found", NotFoundError);

            // Check if the user has permissions to delete media in the project
            checkPermissions(req.user, project.createdBy);

            // Get all media associated with the update
            const updateMedia = await update.getMedia({ transaction: t });

            // Delete the media files
            await deleteMediaFiles(updateMedia, t);
        });
    }
    // If only projectId is provided
    else if (projectId) {
        await sequelize.transaction(async (t) => {
            // Find the project by its ID
            const project = await Project.findByPk(projectId, { transaction: t });
            ThrowErrorIf(!project, "Project not found", NotFoundError);

            // Check if the user has permissions to delete media in the project
            checkPermissions(req.user, project.createdBy);

            // Get all media associated with the project
            const projectMedia = await project.getMedia({ transaction: t });

            // Delete the media files
            await deleteMediaFiles(projectMedia, t);
        });
    }
    // If neither projectId nor updateId is provided
    else {
        throw new BadRequestError('Id is required');
    }

    // Send back a success message to the client
    res.status(StatusCodes.OK).json({
        msg: projectId && updateId
            ? 'All update media deleted'
            : 'All project media deleted',
    });
};

module.exports = {
    getAllMedia,
    updateMedia,
    deleteAllMedia,
    uploadMedia,
    deleteUploadedMedia,
};