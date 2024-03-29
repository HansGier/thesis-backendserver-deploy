const { StatusCodes } = require('http-status-codes');
const {
    sequelize,
    projects: Project,
    users: User,
    tags: Tag,
    barangays: Barangay,
    views: View,
    comments: Comment,
    media: Media,
} = require('../models');
const {
    ThrowErrorIf,
    NotFoundError,
    BadRequestError,
} = require("../errors");
const { getProjectQuery } = require("../utils/helpers");
const { checkPermissions } = require("../utils");
const { validateAndUpdateProject, validationCreate } = require("../utils/helpers/projectsHelpers");
const path = require("path");
const fs = require("fs");

/**
 * Add a new project to the database.
 *
 * @param {Object} req - The request object containing the project data.
 * @param {Object} res - The response object to send the result.
 * @returns {Promise<void>} - A Promise that resolves when the project is created.
 */
const addProject = async (req, res) => {
    const files = req.files;
    // Destructure the project data from the request body
    const {
        title,
        description,
        objectives,
        budget,
        start_date,
        due_date,
        completion_date,
        status,
        tagsIds,
        barangayIds,
    } = req.body;

    try {
        // Validate the tags and barangays, and get the user information
        const { tags, barangays, user } = await validationCreate(req, barangayIds, tagsIds);

        // Define the include options for the Project model
        const includeOptions = [
            {
                model: Tag,
                as: 'tags',
                attributes: ['id', 'name'],
                through: { attributes: [] },
            },
            {
                model: Barangay,
                as: 'barangays',
                attributes: ['name'],
                through: { attributes: [] },
            },
            {
                model: Media,
                as: 'media',
                attributes: ['url', 'mime_type'],
            },
        ];
        // Create the project data object
        const projectData = {
            title,
            description,
            objectives,
            budget,
            start_date,
            due_date,
            completion_date: !completion_date ? null : completion_date,
            status,
            createdBy: user.id,
        };
        const result = await sequelize.transaction(async (t) => {
            // Create the new project and include the tags and barangays
            const newProject = await Project.create(projectData, { include: includeOptions, transaction: t });

            if (files) {
                const mediaRecords = await Promise.all(files.map(async file => {
                    return await Media.create({
                        url: file.path,
                        mime_type: file.mimetype,
                        size: file.size,
                        project_id: newProject.id,
                    }, { transaction: t });
                }));
                await newProject.addMedia(mediaRecords, { transaction: t });
            }

            // Add the tags and barangays to the project
            await Promise.all([newProject.addTags(tags, { transaction: t }), newProject.addBarangays(barangays, { transaction: t })]);

            // Return the new project
            return newProject;
        });

        // Reload the project to include the associated tags and barangays
        await result.reload();

        // Send the response
        res.status(StatusCodes.CREATED).json({ msg: 'Success! New project created', project: result });
    } catch (error) {
        await Promise.all(files.map(async (file) => {
            const filePath = path.normalize(
                path.join(__dirname, "../", file.path),
            );
            await fs.promises.unlink(filePath);
        }));
        throw error;
    }
};

/**
 * Retrieves all projects based on the provided query parameters.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Object} - The response object containing the projects.
 */
const getAllProjects = async (req, res) => {
    // Get the project query options based on the request query parameters
    const options = getProjectQuery(req.query);

    const count = await Project.count();
    // Retrieve all projects based on the options
    const projects = await Project.findAll(options);

    // Add comment, reaction, and report count to each project
    for (const project of projects) {
        project.dataValues.reactionCount = await project.countReactions();
        project.dataValues.commentCount = await project.countComments();
        project.dataValues.reportCount = await project.countReports();
    }

    // If no projects found, return a response with a message
    if (projects.length < 1) return res.status(StatusCodes.OK).json({ msg: 'No projects found' });

    // Return a response with the count of projects and the projects themselves
    else return res.status(StatusCodes.OK).json({
        totalCount: count,
        count: projects.length,
        projects,
    });
};

/**
 * Retrieves a project by its ID.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws {BadRequestError} If the ID is missing or invalid.
 * @throws {NotFoundError} If the project with the given ID is not found.
 * @return {Object} The project object.
 */
const getProject = async (req, res) => {
    // Extract the ID from the request parameters
    const { id } = req.params;

    // Check if the ID is missing or invalid
    ThrowErrorIf(!id || id === ':id' || id === '', 'Id is required', BadRequestError);

    // Get the user ID from the request object
    const { userId } = req.user;

    // Find the project by ID, including associated tags and barangays
    const project = await Project.findByPk(id, {
        attributes: ['id', 'title', 'description', 'objectives', 'budget', 'start_date', 'due_date', 'completion_date', 'status', 'progress', 'views', 'createdBy'],
        include: [
            {
                model: Tag,
                as: 'tags',
                attributes: ['id', 'name'],
                through: { attributes: [] },
            },
            {
                model: Barangay,
                as: 'barangays',
                attributes: ['id', 'name'],
                through: { attributes: [] },
            },
            {
                model: Comment,
                as: 'comments',
                attributes: ['content', 'commented_by'],
            },
            {
                model: Media,
                as: 'views',
                attributes: ['id', 'url', 'mime_type'],
            },
        ],
    });

    // Check if the project with the given ID is not found
    ThrowErrorIf(!project, `Project: ${ id } not found`, NotFoundError);

    if (req.user.role !== 'admin') {
        // Check if there is a view record for the user and project
        const view = await View.findOne({
            where: {
                user_id: userId,
                project_id: id,
            },
        });

        // If there is no view record, create one and increment the project views
        if (!view) {
            await View.create({
                user_id: userId,
                project_id: id,
            });
            await project.increment('views');
        }
        await project.reload();
    }

    // Add reaction count to project
    project.dataValues.reactionCount = await project.countReactions();
    project.dataValues.reportCount = await project.countReports();

    // Send the project object as a JSON response
    res.status(StatusCodes.OK).json({ project });
};


/**
 * Updates a project.
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>} - A promise that resolves when the project is updated.
 */
const updateProject = async (req, res) => {
    // Extract the id from the request parameters
    const { id } = req.params;

    // Throw an error if the id is missing or invalid
    ThrowErrorIf(!id || id === ':id' || id === '', 'Id is required', BadRequestError);

    // Find the project and the user with the given id
    const project = await Project.findOne({ where: { id } });
    const user = await User.findByPk(req.user.userId);

    // Throw an error if the project or the user is not found
    ThrowErrorIf(!project, `Project ${ id } not found`, NotFoundError);
    ThrowErrorIf(!user, 'User not found', NotFoundError);

    // Check the permissions of the user
    checkPermissions(req.user, project.createdBy);

    // Extract the project data from the request body
    const projectData = req.body;

    // Validate and update the project data
    await validateAndUpdateProject(project, projectData, user);

    // Include the tags and barangays in the project
    const includeOptions = [
        {
            model: Tag,
            as: 'tags',
            attributes: ['id', 'name'],
            through: { attributes: [] },
        },
        {
            model: Barangay,
            as: 'barangays',
            attributes: ['id', 'name'],
            through: { attributes: [] },
        },
    ];

    // Reload the project with the updated data
    await project.reload({ include: includeOptions });

    // Send the response with the updated project
    res.status(StatusCodes.OK).json({
        msg: `Success! Project ${ id } updated`,
        project,
    });
};

/**
 * Deletes a project by its ID.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @throws {BadRequestError} If the id is missing.
 * @throws {NotFoundError} If the project is not found.
 * @returns {Object} - The response object with a success message.
 */
const deleteProject = async (req, res) => {
    // Extract the project ID from the request parameters
    const { id } = req.params;

    // Check if the project ID is provided and not empty
    ThrowErrorIf(!id || id === ':id' || id === '', 'Id is required', BadRequestError);

    // Find the project by its ID
    const project = await Project.findByPk(id);

    // Check if the project exists
    ThrowErrorIf(!project, `Project ${ id } not found`, NotFoundError);

    checkPermissions(req.user, project.createdBy);

    // Delete the project
    await project.destroy();

    // Return a success message
    res.status(StatusCodes.OK).json({ msg: `Project: ${ id } deleted` });
};


/**
 * Deletes all projects.
 *
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Object} - The response object with a message that all projects were deleted.
 */
const deleteAllProjects = async (req, res) => {
    // Get the count of projects
    const count = await Project.count();

    // If no projects found, return a success message
    if (count < 1) return res.status(StatusCodes.OK).json({ msg: 'No projects found' });

    // Determine the where clause based on the user's role
    const where = req.user.role === 'admin' ? {} : { createdBy: req.user.userId };

    const projects = await Project.findAll({ where });
    await Promise.all(
        projects.map(async (project) => {
            const mediaRecords = await project.getMedia();
            await Promise.all(
                mediaRecords.map(async (media) => {
                    const filePath = path.normalize(
                        path.join(__dirname, "../", media.url),
                    );
                    await fs.promises.unlink(filePath);
                }),
            );
        }),
    );

    // Delete all projects that match the where clause
    await Project.destroy({ where });

    // Return a success message
    res.status(StatusCodes.OK).json({ msg: 'All projects deleted' });
};


module.exports = {
    addProject,
    getAllProjects,
    getProject,
    updateProject,
    deleteProject,
    deleteAllProjects,
};
