DROP DATABASE IF EXISTS interview_db;
CREATE DATABASE interview_db;
USE interview_db;

CREATE TABLE Admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50),
    password VARCHAR(50)
);

INSERT INTO Admins (username, password) VALUES ('admindangcode', 'mat_khau_sieu_kho_123');
INSERT INTO Admins (username, password) VALUES ('adminkhongcode', '123456');
-- Chọn database trước
USE interview_db;

-- Thêm một admin tên là 'admin' với mật khẩu 'admin123'
INSERT INTO Admins (username, password) 
VALUES ('admin', 'admin123');