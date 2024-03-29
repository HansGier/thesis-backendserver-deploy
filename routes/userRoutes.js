const router = require('express').Router();
const { authenticateUser, authorizePermissions } = require('../middlewares/authentication');
const {
    deleteAllUsers,
    getAllUsers,
    getUser,
    showCurrentUser,
    updateUser,
    deleteUser,
    updateUserPassword,
} = require('../controllers/userController');

router.route('/')
    .get(authenticateUser, authorizePermissions, getAllUsers)
    .delete(authenticateUser, authorizePermissions, deleteAllUsers);

router.route('/me')
    .get(authenticateUser, showCurrentUser);

router.route('/update-user')
    .patch(authenticateUser, updateUser);

router.route('/update-user-password')
    .patch(authenticateUser, updateUserPassword);

router.route('/:id')
    .get(authenticateUser, authorizePermissions, getUser)
    .delete(authenticateUser, authorizePermissions, deleteUser);


module.exports = router;