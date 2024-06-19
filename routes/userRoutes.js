const router = require('express').Router();
const { authenticateUser, authorizePermissions } = require('../middlewares/authentication');
const {
    deleteAllUsers,
    getAllUsers,
    getUser,
    showCurrentUser,
    updateUser,
    deleteUser,
} = require('../controllers/userController');
const { checkUsersCache } = require("../middlewares/checkCache");

router.route('/')
    .get(authenticateUser, checkUsersCache, getAllUsers)
    .delete(authenticateUser, authorizePermissions, deleteAllUsers);

router.route('/me')
    .get(authenticateUser, showCurrentUser);

router.route('/update-user')
    .patch(authenticateUser, updateUser);

router.route('/:id')
    .get(authenticateUser, authorizePermissions, getUser)
    .delete(authenticateUser, authorizePermissions, deleteUser);


module.exports = router;